import { Buffer } from 'node:buffer';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApiServer, type ApiServerDependencies } from './api-server.js';
import type { SyncOperationalRouteRepository } from './sync-operational-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000060';
const webToken = Buffer.alloc(32, 70).toString('base64url');
const mcpToken = Buffer.alloc(32, 71).toString('base64url');
const webhookToken = Buffer.alloc(32, 72).toString('base64url');
const webhookEvent = {
  event: 'item/updated',
  eventId: '20000000-0000-4000-8000-000000000060',
  itemId: '30000000-0000-4000-8000-000000000060',
  triggeredBy: 'SYNC',
};

const servers: ReturnType<typeof createApiServer>[] = [];

function repository(): SyncOperationalRouteRepository {
  return {
    getSyncRun: vi.fn(async () => null),
    listDeadLetters: vi.fn(async () => []),
    listSyncRuns: vi.fn(async () => []),
    requestManualReconciliation: vi.fn(async () => ({
      outcome: 'CONNECTION_NOT_AVAILABLE' as const,
    })),
    retryDeadLetter: vi.fn(async () => ({ outcome: 'NOT_FOUND' as const })),
  };
}

function dependencies(
  nodeEnvironment: ApiServerDependencies['nodeEnvironment'] = 'test',
): ApiServerDependencies {
  return {
    inbox: {
      ingestAuthenticatedPluggyWebhook: vi.fn(async () => ({ duplicate: false, mapped: true })),
    },
    mcpToken,
    nodeEnvironment,
    operational: { repository: repository(), webToken, workspaceId },
    readiness: vi.fn(async () => true),
    webhookSecret: webhookToken,
    workspaceId,
  };
}

function buildServer(nodeEnvironment: ApiServerDependencies['nodeEnvironment'] = 'test') {
  const server = createApiServer(dependencies(nodeEnvironment));
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe('Fastify API framework', () => {
  it('rejects reused credentials and mismatched route workspace configuration', () => {
    const reused = dependencies();
    reused.mcpToken = reused.webhookSecret;
    expect(() => createApiServer(reused)).toThrow(/credentials must be distinct/u);

    const mismatched = dependencies();
    if (mismatched.operational === undefined) throw new Error('Expected operational fixture.');
    mismatched.operational.workspaceId = '10000000-0000-4000-8000-000000000061';
    expect(() => createApiServer(mismatched)).toThrow(/configured workspace/u);
  });

  it('provides request-identified liveness and database-backed readiness', async () => {
    const server = buildServer();
    const live = await server.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.headers['cache-control']).toBe('no-store');
    expect(live.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(live.json()).toMatchObject({ status: 'live' });

    const ready = await server.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ready' });
  });

  it('returns a bounded readiness problem without exposing the failure', async () => {
    const config = dependencies();
    config.readiness = vi.fn(async () => {
      throw new Error('synthetic database hostname and credential detail');
    });
    const server = createApiServer(config);
    servers.push(server);

    const response = await server.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: 'NOT_READY', status: 503 });
    expect(response.body).not.toContain('hostname');
    expect(response.body).not.toContain('credential');
  });

  it('keeps web-owner and webhook route credentials non-substitutable', async () => {
    const server = buildServer();
    for (const token of [mcpToken, webhookToken]) {
      const response = await server.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'GET',
        url: '/v1/sync-runs',
      });
      expect(response.statusCode).toBe(401);
    }
    const webResponse = await server.inject({
      headers: { authorization: `Bearer ${webToken}` },
      method: 'GET',
      url: '/v1/sync-runs',
    });
    expect(webResponse.statusCode).toBe(200);
    expect(webResponse.json()).toMatchObject({ meta: { workspaceId } });

    for (const token of [webToken, mcpToken]) {
      const response = await server.inject({
        headers: { authorization: `Bearer ${token}` },
        method: 'POST',
        payload: webhookEvent,
        url: '/webhooks/pluggy',
      });
      expect(response.statusCode).toBe(401);
    }
    const webhookResponse = await server.inject({
      headers: { authorization: `Bearer ${webhookToken}` },
      method: 'POST',
      payload: webhookEvent,
      url: '/webhooks/pluggy',
    });
    expect(webhookResponse.statusCode).toBe(202);
  });

  it('keeps webhook media and body limits bounded at the framework edge', async () => {
    const config = dependencies();
    config.bodyLimitBytes = 16;
    const server = createApiServer(config);
    servers.push(server);
    const authorization = `Bearer ${webhookToken}`;

    const unsupported = await server.inject({
      headers: { authorization, 'content-type': 'text/plain' },
      method: 'POST',
      payload: 'synthetic',
      url: '/webhooks/pluggy',
    });
    expect(unsupported.statusCode).toBe(415);

    const oversized = await server.inject({
      headers: { authorization },
      method: 'POST',
      payload: webhookEvent,
      url: '/webhooks/pluggy',
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' });
  });

  it('publishes generated OpenAPI only in development', async () => {
    const development = buildServer('development');
    const specification = await development.inject({
      method: 'GET',
      url: '/documentation/json',
    });
    expect(specification.statusCode).toBe(200);
    expect(specification.json()).toMatchObject({
      info: { title: 'CashCount Finance API' },
      openapi: '3.1.0',
    });
    expect(specification.body).not.toContain(webToken);
    expect(specification.body).not.toContain(mcpToken);
    expect(specification.body).not.toContain(webhookToken);

    const production = buildServer('production');
    const hidden = await production.inject({ method: 'GET', url: '/documentation/json' });
    expect(hidden.statusCode).toBe(404);
  });
});
