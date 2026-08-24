import type { ClaimedQueueJob, ReconciliationConnectionTarget } from '@cashcount/db';
import type { ProviderConnectionDto } from '@cashcount/provider-core';
import { describe, expect, it } from 'vitest';

import {
  createManualReconciliationHandler,
  type ManualReconciliationHandlerOptions,
} from './manual-reconciliation-handler.js';

const workspaceId = '10000000-0000-4000-8000-000000000001';
const providerConnectionId = '20000000-0000-4000-8000-000000000001';
const externalConnectionId = '30000000-0000-4000-8000-000000000001';
const now = new Date('2026-08-24T13:00:00.000Z');

function job(payload: ClaimedQueueJob['payload'] = { providerConnectionId }): ClaimedQueueJob {
  return {
    attemptCount: 1,
    availableAt: now,
    dedupeKey: `manual-reconcile:${providerConnectionId}`,
    heartbeatAt: now,
    id: '40000000-0000-4000-8000-000000000001',
    jobType: 'SYNC_CONNECTION',
    leaseExpiresAt: new Date('2026-08-24T13:02:00.000Z'),
    maxAttempts: 8,
    payload,
    priority: 100,
    startedAt: now,
    status: 'RUNNING',
    workspaceId,
  };
}

function snapshot(): ProviderConnectionDto {
  return {
    actionRequiredAt: null,
    consentExpiresAt: null,
    displayName: 'Synthetic Bank',
    errorCode: null,
    executionStatus: 'SUCCESS',
    externalConnectionId,
    externalConnectorId: '601',
    itemStatus: 'UPDATED',
    localStatus: 'ACTIVE',
    providerUpdatedAt: now.toISOString(),
    raw: { synthetic: true },
  };
}

function options(calls: string[], target: ReconciliationConnectionTarget | null) {
  const responses = [snapshot(), snapshot(), snapshot()];
  const configured: ManualReconciliationHandlerOptions = {
    applyConnectionSnapshot: async () => {
      calls.push('apply');
    },
    fullImport: async () => {
      calls.push('full-import');
    },
    maxPollAttempts: 2,
    now: () => now,
    persistence: {
      getEnabledConnection: async () => target,
      isConnectionEnabled: async () => true,
      listEnabledConnections: async () => [],
      markConnectionAttempted: async () => {
        calls.push('attempted');
      },
      markConnectionDeleted: async () => undefined,
      markConnectionSuccessful: async () => {
        calls.push('successful');
      },
      markConnectionSyncing: async () => {
        calls.push('syncing');
      },
      recordActionEvidence: async () => undefined,
      tryRunExclusive: async (_scope, action) => ({ acquired: true, value: await action() }),
      withConnectionLock: async (_scope, _externalId, action) => action(),
    },
    pollIntervalMs: 1,
    provider: {
      getConnection: async () => {
        calls.push('get-item');
        const response = responses.shift();
        if (response === undefined) throw new Error('Unexpected Item observation.');
        return response;
      },
      requestConnectionRefresh: async () => {
        calls.push('request-refresh');
      },
    },
    sleep: async () => undefined,
  };
  return configured;
}

const target: ReconciliationConnectionTarget = {
  externalConnectionId,
  localStatus: 'ACTIVE',
  providerConnectionId,
  workspaceId,
};

describe('manual reconciliation queue handler', () => {
  it('reconciles exactly the internal connection carried by a workspace job', async () => {
    const calls: string[] = [];
    const handler = createManualReconciliationHandler(options(calls, target));

    await expect(
      handler(job(), { signal: new AbortController().signal, workerId: 'synthetic-worker' }),
    ).resolves.toBeUndefined();
    expect(calls).toEqual([
      'attempted',
      'get-item',
      'request-refresh',
      'syncing',
      'get-item',
      'full-import',
      'successful',
      'get-item',
      'apply',
    ]);
  });

  it('rejects malformed or system-scoped jobs as permanent failures', async () => {
    const handler = createManualReconciliationHandler(options([], target));
    const malformed = { ...job({}), workspaceId: null };

    await expect(
      handler(malformed, {
        signal: new AbortController().signal,
        workerId: 'synthetic-worker',
      }),
    ).rejects.toMatchObject({
      errorCode: 'INVALID_SYNC_CONNECTION_JOB',
      retryable: false,
    });
  });

  it('closes a job permanently when its connection is no longer available', async () => {
    const handler = createManualReconciliationHandler(options([], null));

    await expect(
      handler(job(), { signal: new AbortController().signal, workerId: 'synthetic-worker' }),
    ).rejects.toMatchObject({
      errorCode: 'CONNECTION_NOT_AVAILABLE',
      retryable: false,
    });
  });

  it('redacts and retries an unexpected persistence failure', async () => {
    const configured = options([], target);
    configured.persistence.getEnabledConnection = async () => {
      throw new Error('synthetic database detail that must not escape');
    };
    const handler = createManualReconciliationHandler(configured);

    await expect(
      handler(job(), { signal: new AbortController().signal, workerId: 'synthetic-worker' }),
    ).rejects.toMatchObject({
      errorCode: 'MANUAL_RECONCILIATION_FAILED',
      message: 'Manual connection reconciliation did not complete.',
      retryable: true,
    });
  });
});
