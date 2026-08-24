import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import {
  AccountImportRepository,
  BillImportRepository,
  createDatabaseClient,
  PayloadEncryptionService,
  ProviderConnectionRepository,
  ReconciliationRepository,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
  TransactionImportRepository,
  TransactionReplacementRepository,
} from '@cashcount/db';
import {
  PluggyApiKeyProvider,
  PluggyAuthenticatedHttpClient,
  PluggyDataClient,
} from '@cashcount/provider-pluggy';
import {
  pluggyAccountBody,
  pluggyBillsBody,
  pluggyFixtureIds,
  pluggyItemLifecycleFixtures,
  pluggyTransactionMatrixBody,
} from '@cashcount/test-fixtures';
import { describe, expect, it, vi } from 'vitest';

import { runFullImport } from './full-import.js';
import { runScheduledReconciliation } from './scheduled-reconciliation.js';

function requireItemFixture(name: string): string {
  const fixture = pluggyItemLifecycleFixtures.find((candidate) => candidate.name === name);
  if (fixture === undefined) throw new Error(`Expected Item fixture ${name}.`);
  return fixture.responseBody;
}

const activeItemBody = requireItemFixture('successful update');
const syncingItemBody = requireItemFixture('account synchronization in progress');

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_reconciliation_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected reconciliation database identifier.');
  }
  return `"${identifier}"`;
}

function jsonResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' }, status: 200 });
}

function fixtureProvider(requests: string[]): PluggyDataClient {
  const itemGets = [
    activeItemBody,
    syncingItemBody,
    activeItemBody,
    activeItemBody,
    activeItemBody,
  ];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = input instanceof Request ? input.method : (init?.method ?? 'GET');
    requests.push(`${method} ${url.pathname}`);
    if (url.pathname === '/auth') return jsonResponse('{"accessToken":"synthetic-api-key"}');
    if (url.pathname === `/items/${pluggyFixtureIds.connection}` && method === 'PATCH') {
      return jsonResponse(syncingItemBody);
    }
    if (url.pathname === `/items/${pluggyFixtureIds.connection}`) {
      const body = itemGets.shift();
      if (body === undefined) throw new Error('Unexpected extra Item observation.');
      return jsonResponse(body);
    }
    if (url.pathname === '/accounts') {
      return jsonResponse(`{"results":[${pluggyAccountBody}]}`);
    }
    if (url.pathname === '/v2/transactions') return jsonResponse(pluggyTransactionMatrixBody);
    if (url.pathname === '/bills') return jsonResponse(pluggyBillsBody);
    throw new Error(`Unexpected synthetic provider path ${url.pathname}.`);
  });
  const apiKeyProvider = new PluggyApiKeyProvider({
    baseUrl: 'https://provider.example.test',
    clientId: 'synthetic-client-id',
    clientSecret: 'synthetic-client-secret',
    fetchImpl,
    requestId: () => 'synthetic-reconciliation-auth',
  });
  return new PluggyDataClient({
    httpClient: new PluggyAuthenticatedHttpClient({
      apiKeyProvider,
      baseUrl: 'https://provider.example.test',
      fetchImpl,
      maxRetries: 0,
      requestId: () => 'synthetic-reconciliation-data',
    }),
  });
}

describe('scheduled reconciliation regression', () => {
  it('repairs missed provider changes and advances connection freshness', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_reconciliation_${randomUUID().replaceAll('-', '')}`;
    const databaseUrlObject = new URL(databaseUrl);
    databaseUrlObject.pathname = `/${databaseName}`;
    const admin = createDatabaseClient(databaseUrl);

    try {
      await admin.pool.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(databaseUrlObject.toString());
      await seedSyntheticIdentity(databaseUrlObject.toString(), 'test');
      const client = createDatabaseClient(databaseUrlObject.toString());
      try {
        const workspaceId = syntheticIdentitySeed.workspace.id;
        const providerConnectionId = '41000000-0000-4000-8000-000000000044';
        await client.pool.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, $2, 'PLUGGY', $3, '601', 'Synthetic Reconciliation Bank')`,
          [providerConnectionId, workspaceId, pluggyFixtureIds.connection],
        );
        const requests: string[] = [];
        const provider = fixtureProvider(requests);
        const encryption = new PayloadEncryptionService({
          activeKeyVersion: 13,
          keyring: new Map([[13, new Uint8Array(32).fill(44)]]),
        });
        const accountPersistence = new AccountImportRepository(client.database);
        const billPersistence = new BillImportRepository(client.database);
        const connectionPersistence = new ProviderConnectionRepository(client.database);
        const persistence = new ReconciliationRepository(client.pool);
        const replacementDetector = new TransactionReplacementRepository(client.pool);
        const transactionPersistence = new TransactionImportRepository(client.database);
        const completedAt = new Date('2026-08-24T12:00:00.000Z');

        await expect(
          persistence.tryRunExclusive(workspaceId, async () => {
            const contender = await new ReconciliationRepository(client.pool).tryRunExclusive(
              workspaceId,
              async () => 'unexpected',
            );
            expect(contender).toEqual({ acquired: false });
            return 'held';
          }),
        ).resolves.toEqual({ acquired: true, value: 'held' });

        const result = await runScheduledReconciliation({
          applyConnectionSnapshot: async (scope, connectionId, snapshot) => {
            const assigned = await connectionPersistence.assignDiscoveredConnections(scope, [
              snapshot,
            ]);
            expect(assigned).toHaveLength(1);
            expect(assigned[0]?.id).toBe(connectionId);
          },
          fullImport: async (scope, connectionId) =>
            runFullImport({
              accountPersistence,
              billPersistence,
              encryption,
              now: () => completedAt,
              provider,
              providerConnectionId: connectionId,
              replacementDetector,
              transactionPersistence,
              triggerType: 'SCHEDULED',
              workspaceId: scope,
            }),
          maxPollAttempts: 3,
          now: () => completedAt,
          persistence,
          pollIntervalMs: 1,
          provider,
          reconciliationRunId: '42000000-0000-4000-8000-000000000044',
          sleep: async () => undefined,
          workspaceId,
        });

        expect(result).toEqual({
          actionRequired: 0,
          connectionsDeleted: 0,
          connectionsFailed: 0,
          connectionsReconciled: 1,
          overlapSkipped: false,
          targetsSeen: 1,
        });
        const state = await client.pool.query<{
          accounts: number;
          bills: number;
          last_attempt_at: Date | null;
          last_successful_sync_at: Date | null;
          local_status: string;
          scheduled_runs: number;
          transactions: number;
        }>(
          `select pc.local_status, pc.last_attempt_at, pc.last_successful_sync_at,
             (select count(*)::integer from financial_account where workspace_id = $1) as accounts,
             (select count(*)::integer from financial_transaction where workspace_id = $1) as transactions,
             (select count(*)::integer from credit_card_bill where workspace_id = $1) as bills,
             (select count(*)::integer from sync_run
              where workspace_id = $1 and trigger_type = 'SCHEDULED' and status = 'SUCCEEDED')
               as scheduled_runs
           from provider_connection pc where pc.workspace_id = $1 and pc.id = $2`,
          [workspaceId, providerConnectionId],
        );
        expect(state.rows[0]).toEqual({
          accounts: 1,
          bills: 1,
          last_attempt_at: completedAt,
          last_successful_sync_at: completedAt,
          local_status: 'ACTIVE',
          scheduled_runs: 1,
          transactions: 4,
        });
        expect(requests).toContain(`PATCH /items/${pluggyFixtureIds.connection}`);
        expect(requests).toContain('GET /v2/transactions');
        expect(requests).not.toContain('GET /transactions');
      } finally {
        await client.pool.end();
      }
    } finally {
      await admin.pool.query(`drop database if exists ${quoteDatabase(databaseName)}`);
      await admin.pool.end();
    }
  }, 30_000);
});
