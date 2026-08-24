import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import {
  processSyncOperationalRequest,
  type SyncOperationalRouteDependencies,
  type SyncOperationalRouteRepository,
} from './sync-operational-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const connectionId = '20000000-0000-4000-8000-000000000001';
const syncRunId = '30000000-0000-4000-8000-000000000001';
const jobId = '40000000-0000-4000-8000-000000000001';
const requestId = '50000000-0000-4000-8000-000000000001';
const now = new Date('2026-08-24T14:00:00.000Z');
const webToken = Buffer.alloc(32, 71).toString('base64url');
const webhookToken = Buffer.alloc(32, 72).toString('base64url');
const mcpToken = Buffer.alloc(32, 73).toString('base64url');

function repository(): SyncOperationalRouteRepository {
  return {
    getSyncRun: vi.fn<SyncOperationalRouteRepository['getSyncRun']>(async () => ({
      accountsSeen: 1,
      billsSeen: 1,
      connectionDisplayName: 'Synthetic Bank',
      connectionId,
      connectionStatus: 'ACTIVE',
      errorSummary: null,
      finishedAt: now,
      id: syncRunId,
      startedAt: new Date('2026-08-24T13:59:00.000Z'),
      status: 'SUCCEEDED',
      transactionsDeleted: 0,
      transactionsInserted: 4,
      transactionsSeen: 4,
      transactionsUpdated: 0,
      triggerType: 'MANUAL',
    })),
    listDeadLetters: vi.fn<SyncOperationalRouteRepository['listDeadLetters']>(async () => [
      {
        attemptCount: 8,
        availableAt: now,
        createdAt: new Date('2026-08-24T12:00:00.000Z'),
        finishedAt: now,
        id: jobId,
        jobType: 'SYNC_CONNECTION',
        lastErrorCode: 'PROVIDER_UNAVAILABLE',
        lastErrorSummary: 'Provider request did not complete.',
        maxAttempts: 8,
        startedAt: new Date('2026-08-24T13:00:00.000Z'),
      },
    ]),
    listSyncRuns: vi.fn<SyncOperationalRouteRepository['listSyncRuns']>(async () => []),
    requestManualReconciliation: vi.fn<
      SyncOperationalRouteRepository['requestManualReconciliation']
    >(async () => ({
      job: {
        attemptCount: 0,
        availableAt: now,
        created: true,
        dedupeKey: `manual-reconcile:${connectionId}`,
        id: jobId,
        jobType: 'SYNC_CONNECTION',
        maxAttempts: 8,
        payload: { providerConnectionId: connectionId },
        priority: 100,
        status: 'PENDING',
        workspaceId,
      },
      outcome: 'ENQUEUED' as const,
    })),
    retryDeadLetter: vi.fn<SyncOperationalRouteRepository['retryDeadLetter']>(async () => ({
      job: {
        attemptCount: 8,
        availableAt: now,
        id: jobId,
        maxAttempts: 9,
        status: 'RETRY',
      },
      outcome: 'RETRIED' as const,
    })),
  };
}

function dependencies(repo = repository()): SyncOperationalRouteDependencies {
  return {
    now: () => now,
    repository: repo,
    requestId: () => requestId,
    webToken,
    workspaceId,
  };
}

function request(path: string, method = 'GET', token = webToken, hasBody = false) {
  return {
    authorizationHeader: `Bearer ${token}`,
    hasBody,
    method,
    url: new URL(path, 'https://api.cashcount.test'),
  };
}

describe('sync operational routes', () => {
  it('rejects missing, webhook, and MCP credentials before repository access', async () => {
    const repo = repository();
    const config = dependencies(repo);

    for (const authorizationHeader of [null, `Bearer ${webhookToken}`, `Bearer ${mcpToken}`]) {
      await expect(
        processSyncOperationalRequest({ ...request('/v1/sync-runs'), authorizationHeader }, config),
      ).resolves.toMatchObject({ status: 401 });
    }
    expect(repo.listSyncRuns).not.toHaveBeenCalled();
  });

  it('binds list scope to server configuration and validates bounded query/output contracts', async () => {
    const repo = repository();
    const config = dependencies(repo);

    const result = await processSyncOperationalRequest(
      request('/v1/jobs/dead-letter?limit=25'),
      config,
    );
    expect(repo.listDeadLetters).toHaveBeenCalledWith(workspaceId, 25);
    expect(result).toMatchObject({
      body: {
        data: { items: [{ id: jobId, jobType: 'SYNC_CONNECTION' }], limit: 25 },
        meta: { requestId, workspaceId },
      },
      headers: { 'x-request-id': requestId },
      status: 200,
    });
    await expect(
      processSyncOperationalRequest(request('/v1/sync-runs?workspaceId=attacker'), config),
    ).resolves.toMatchObject({ status: 400 });
  });

  it('returns one scoped sync run and omits database-only cursor state', async () => {
    const result = await processSyncOperationalRequest(
      request(`/v1/sync-runs/${syncRunId}`),
      dependencies(),
    );

    expect(result).toMatchObject({
      body: { data: { id: syncRunId, status: 'SUCCEEDED', triggerType: 'MANUAL' } },
      status: 200,
    });
    expect(JSON.stringify(result)).not.toContain('cursorState');
  });

  it('enqueues reconcile and retries a dead letter without accepting a request body', async () => {
    const repo = repository();
    const config = dependencies(repo);
    await expect(
      processSyncOperationalRequest(
        request(`/v1/connections/${connectionId}/reconcile`, 'POST'),
        config,
      ),
    ).resolves.toMatchObject({ body: { data: { created: true, id: jobId } }, status: 202 });
    expect(repo.requestManualReconciliation).toHaveBeenCalledWith(workspaceId, connectionId, now);

    await expect(
      processSyncOperationalRequest(request(`/v1/jobs/${jobId}/retry`, 'POST'), config),
    ).resolves.toMatchObject({
      body: { data: { id: jobId, maxAttempts: 9, status: 'RETRY' } },
      status: 202,
    });
    expect(repo.retryDeadLetter).toHaveBeenCalledWith(workspaceId, jobId, now);

    await expect(
      processSyncOperationalRequest(
        request(`/v1/jobs/${jobId}/retry`, 'POST', webToken, true),
        config,
      ),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      processSyncOperationalRequest(
        {
          ...request('/v1/sync-runs'),
          invalidContentLength: true,
        },
        config,
      ),
    ).resolves.toMatchObject({ body: { code: 'INVALID_CONTENT_LENGTH' }, status: 400 });
  });

  it('maps not-found, conflict, invalid ID, and method errors to bounded problems', async () => {
    const repo = repository();
    repo.getSyncRun = vi.fn<SyncOperationalRouteRepository['getSyncRun']>(async () => null);
    repo.retryDeadLetter = vi.fn<SyncOperationalRouteRepository['retryDeadLetter']>(async () => ({
      outcome: 'NOT_DEAD',
    }));
    const config = dependencies(repo);

    await expect(
      processSyncOperationalRequest(request(`/v1/sync-runs/${syncRunId}`), config),
    ).resolves.toMatchObject({ status: 404 });
    await expect(
      processSyncOperationalRequest(request(`/v1/jobs/${jobId}/retry`, 'POST'), config),
    ).resolves.toMatchObject({ body: { code: 'NOT_DEAD' }, status: 409 });
    await expect(
      processSyncOperationalRequest(request('/v1/jobs/not-a-uuid/retry', 'POST'), config),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      processSyncOperationalRequest(request(`/v1/sync-runs/${syncRunId}?workspaceId=x`), config),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      processSyncOperationalRequest(request('/v1/sync-runs', 'POST'), config),
    ).resolves.toMatchObject({ headers: { allow: 'GET' }, status: 405 });
  });
});
