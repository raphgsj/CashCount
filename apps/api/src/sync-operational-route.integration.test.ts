import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import { parseDatabaseConfig } from '@cashcount/config';
import { SyncOperationalRepository } from '@cashcount/db/operational';
import {
  createWebhookDatabasePool,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
} from '@cashcount/db/webhook';
import { describe, expect, it } from 'vitest';

import { processSyncOperationalRequest } from './sync-operational-route.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_sync_operations_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected sync operations database identifier.');
  }
  return `"${identifier}"`;
}

describe('sync operational route integration', () => {
  it('isolates reads, deduplicates manual reconcile, and retries supported dead letters', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_sync_operations_${randomUUID().replaceAll('-', '')}`;
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${databaseName}`;
    const admin = createWebhookDatabasePool(databaseUrl);

    try {
      await admin.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(testUrl.toString());
      await seedSyntheticIdentity(testUrl.toString(), 'test');
      const client = createWebhookDatabasePool(testUrl.toString());
      client.on('error', () => undefined);
      try {
        const workspaceId = syntheticIdentitySeed.workspace.id;
        const otherWorkspaceId = '10000000-0000-4000-8000-000000000045';
        const connectionId = '20000000-0000-4000-8000-000000000045';
        const otherConnectionId = '21000000-0000-4000-8000-000000000045';
        const syncRunId = '30000000-0000-4000-8000-000000000045';
        const otherSyncRunId = '31000000-0000-4000-8000-000000000045';
        const deadJobId = '40000000-0000-4000-8000-000000000045';
        const unsupportedJobId = '41000000-0000-4000-8000-000000000045';
        const otherJobId = '42000000-0000-4000-8000-000000000045';
        const conflictDeadJobId = '43000000-0000-4000-8000-000000000045';
        const conflictActiveJobId = '44000000-0000-4000-8000-000000000045';
        const completedAt = new Date('2026-08-24T15:00:00.000Z');
        await client.query(`insert into workspace (id, name) values ($1, 'Other Workspace')`, [
          otherWorkspaceId,
        ]);
        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values
             ($1, $2, 'PLUGGY', 'synthetic-operation-item', '601', 'Synthetic Operations Bank'),
             ($3, $4, 'PLUGGY', 'other-operation-item', '602', 'Other Operations Bank')`,
          [connectionId, workspaceId, otherConnectionId, otherWorkspaceId],
        );
        await client.query(
          `insert into sync_run (
             id, workspace_id, provider_connection_id, trigger_type, status, started_at, finished_at,
             accounts_seen, transactions_seen, transactions_inserted, bills_seen
           ) values
             ($1, $2, $3, 'MANUAL', 'SUCCEEDED', $7::timestamptz - interval '1 minute',
              $7::timestamptz, 1, 4, 4, 1),
             ($4, $5, $6, 'SCHEDULED', 'SUCCEEDED', $7::timestamptz - interval '2 minutes',
              $7::timestamptz, 1, 1, 1, 0)`,
          [
            syncRunId,
            workspaceId,
            connectionId,
            otherSyncRunId,
            otherWorkspaceId,
            otherConnectionId,
            completedAt,
          ],
        );
        await client.query(
          `insert into job_queue (
             id, workspace_id, job_type, payload, dedupe_key, status, available_at,
             started_at, finished_at, attempt_count, max_attempts, last_error_code,
             last_error_summary, created_at, updated_at
           ) values
             ($1, $2, 'SYNC_CONNECTION', jsonb_build_object('providerConnectionId', $3::text),
              'failed-manual', 'DEAD', $7::timestamptz,
              $7::timestamptz - interval '1 minute', $7::timestamptz, 8, 8,
              'PROVIDER_UNAVAILABLE', 'Provider request did not complete.',
              $7::timestamptz, $7::timestamptz),
             ($4, $2, 'SYNC_ACCOUNT', '{}'::jsonb, null, 'DEAD', $7::timestamptz,
              $7::timestamptz - interval '1 minute', $7::timestamptz, 1, 1,
              'UNSUPPORTED_FIXTURE', 'Synthetic unsupported job.',
              $7::timestamptz, $7::timestamptz),
             ($5, $6, 'SYNC_CONNECTION', jsonb_build_object('providerConnectionId', $8::text),
              'other-failed-manual', 'DEAD', $7::timestamptz,
              $7::timestamptz - interval '1 minute', $7::timestamptz, 8, 8,
              'OTHER_WORKSPACE', 'Synthetic other workspace job.',
              $7::timestamptz, $7::timestamptz)`,
          [
            deadJobId,
            workspaceId,
            connectionId,
            unsupportedJobId,
            otherJobId,
            otherWorkspaceId,
            completedAt,
            otherConnectionId,
          ],
        );

        const repository = new SyncOperationalRepository(client);
        const webToken = Buffer.alloc(32, 81).toString('base64url');
        const dependencies = {
          now: () => completedAt,
          repository,
          requestId: () => '50000000-0000-4000-8000-000000000045',
          webToken,
          workspaceId,
        };
        const authorizationHeader = `Bearer ${webToken}`;
        const get = (path: string) =>
          processSyncOperationalRequest(
            {
              authorizationHeader,
              hasBody: false,
              method: 'GET',
              url: new URL(path, 'https://api.cashcount.test'),
            },
            dependencies,
          );
        const post = (path: string) =>
          processSyncOperationalRequest(
            {
              authorizationHeader,
              hasBody: false,
              method: 'POST',
              url: new URL(path, 'https://api.cashcount.test'),
            },
            dependencies,
          );

        await expect(get('/v1/sync-runs')).resolves.toMatchObject({
          body: { data: { items: [{ id: syncRunId }] } },
          status: 200,
        });
        await expect(get('/v1/jobs/dead-letter')).resolves.toMatchObject({
          body: { data: { items: [{ id: unsupportedJobId }, { id: deadJobId }] } },
          status: 200,
        });
        await expect(get(`/v1/sync-runs/${otherSyncRunId}`)).resolves.toMatchObject({
          status: 404,
        });
        await expect(post(`/v1/jobs/${otherJobId}/retry`)).resolves.toMatchObject({ status: 404 });
        await expect(post(`/v1/jobs/${unsupportedJobId}/retry`)).resolves.toMatchObject({
          body: { code: 'UNSUPPORTED' },
          status: 409,
        });
        await expect(post(`/v1/jobs/${deadJobId}/retry`)).resolves.toMatchObject({
          body: { data: { id: deadJobId, maxAttempts: 9, status: 'RETRY' } },
          status: 202,
        });
        await client.query(
          `insert into job_queue (
             id, workspace_id, job_type, payload, dedupe_key, status, available_at,
             finished_at, attempt_count, max_attempts, last_error_code, last_error_summary,
             created_at, updated_at
           ) values
             ($1, $3, 'SYNC_CONNECTION', jsonb_build_object('providerConnectionId', $4::text),
              'conflicting-manual', 'DEAD', $5, $5, 8, 8, 'SYNTHETIC_DEAD',
              'Synthetic dead job.', $5, $5),
             ($2, $3, 'SYNC_CONNECTION', jsonb_build_object('providerConnectionId', $4::text),
              'conflicting-manual', 'PENDING', $5, null, 0, 8, null, null, $5, $5)`,
          [conflictDeadJobId, conflictActiveJobId, workspaceId, connectionId, completedAt],
        );
        await expect(post(`/v1/jobs/${conflictDeadJobId}/retry`)).resolves.toMatchObject({
          body: { code: 'ACTIVE_CONFLICT' },
          status: 409,
        });
        const firstManual = await post(`/v1/connections/${connectionId}/reconcile`);
        const secondManual = await post(`/v1/connections/${connectionId}/reconcile`);
        expect(firstManual).toMatchObject({ body: { data: { created: true } }, status: 202 });
        expect(secondManual).toMatchObject({ body: { data: { created: false } }, status: 202 });

        const state = await client.query<{
          audit_count: number;
          manual_jobs: number;
          retried_max_attempts: number;
          retried_status: string;
        }>(
          `select
             (select status from job_queue where workspace_id = $1 and id = $2) as retried_status,
             (select max_attempts from job_queue where workspace_id = $1 and id = $2)
               as retried_max_attempts,
             (select count(*)::integer from job_queue
              where workspace_id = $1 and job_type = 'SYNC_CONNECTION'
                and dedupe_key = $3) as manual_jobs,
             (select count(*)::integer from audit_event
              where workspace_id = $1 and event_type in
                ('DEAD_LETTER_RETRIED', 'MANUAL_RECONCILIATION_REQUESTED')) as audit_count`,
          [workspaceId, deadJobId, `manual-reconcile:${connectionId}`],
        );
        expect(state.rows[0]).toEqual({
          audit_count: 3,
          manual_jobs: 1,
          retried_max_attempts: 9,
          retried_status: 'RETRY',
        });
      } finally {
        await client.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)} with (force)`);
      await admin.end();
    }
  }, 30_000);
});
