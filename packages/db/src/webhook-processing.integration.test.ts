import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { providerTransactionSchema } from '@cashcount/provider-core';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createDatabaseClient } from './client.js';
import { PayloadEncryptionService } from './encryption.js';
import { JobQueueRepository } from './job-queue-repository.js';
import { runMigrations } from './migrations.js';
import { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';
import { TransactionImportRepository } from './transaction-import-repository.js';
import {
  authenticatedWebhookIngestionCapability,
  WebhookInboxRepository,
} from './webhook-inbox-repository.js';
import {
  WebhookProcessingInvariantError,
  WebhookProcessingRepository,
} from './webhook-processing-repository.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_webhook_processing_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected webhook test database identifier.');
  }
  return `"${identifier}"`;
}

describe('PostgreSQL webhook processing repositories', () => {
  it('processes encrypted lifecycle state and scoped transaction deletion idempotently', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_webhook_processing_${randomUUID().replaceAll('-', '')}`;
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: databaseUrl });

    try {
      await admin.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(testUrl.toString());
      await seedSyntheticIdentity(testUrl.toString(), 'test');
      const client = createDatabaseClient(testUrl.toString());
      try {
        const workspaceId = syntheticIdentitySeed.workspace.id;
        const providerConnectionId = '31000000-0000-4000-8000-000000000043';
        const externalConnectionId = '32000000-0000-4000-8000-000000000043';
        const financialAccountId = '33000000-0000-4000-8000-000000000043';
        const externalAccountId = '34000000-0000-4000-8000-000000000043';
        const externalTransactionId = '35000000-0000-4000-8000-000000000043';
        await client.pool.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, $2, 'PLUGGY', $3, '601', 'Synthetic Webhook Bank')`,
          [providerConnectionId, workspaceId, externalConnectionId],
        );
        await client.pool.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency
           ) values ($1, $2, $3, 'PLUGGY', $4, 'CHECKING',
             'Synthetic checking', 'Synthetic Webhook Bank', 'BRL')`,
          [financialAccountId, workspaceId, providerConnectionId, externalAccountId],
        );

        const encryption = new PayloadEncryptionService({
          activeKeyVersion: 7,
          keyring: new Map([[7, new Uint8Array(32).fill(67)]]),
        });
        const transactionPersistence = new TransactionImportRepository(client.database);
        const started = await transactionPersistence.startWebhookSync(
          workspaceId,
          providerConnectionId,
          externalAccountId,
          new Date('2026-08-24T10:00:00.000Z'),
        );
        const account = started.accounts[0];
        if (account === undefined) throw new Error('Expected a webhook transaction account.');
        const transaction = providerTransactionSchema.parse({
          accountCurrency: 'BRL',
          amountInAccountCurrencySigned: '-10',
          amountSigned: '-10',
          categoryId: null,
          categoryName: null,
          creditCardMetadata: null,
          currency: 'BRL',
          description: 'Synthetic purchase',
          descriptionRaw: null,
          externalAccountId,
          externalTransactionId,
          merchant: null,
          operationType: null,
          operationTypeAdditionalInfo: null,
          providerCode: null,
          providerId: null,
          providerType: 'DEBIT',
          purchaseAt: null,
          raw: { synthetic: true },
          status: 'POSTED',
          transactionAt: '2026-08-24T09:00:00.000Z',
        });
        await transactionPersistence.importPage(
          workspaceId,
          started.syncRunId,
          account,
          [transaction],
          null,
          encryption,
          new Date('2026-08-24T10:00:01.000Z'),
        );
        await expect(
          transactionPersistence.deleteWebhookTransactions(
            workspaceId,
            started.syncRunId,
            account,
            [externalTransactionId],
            new Date('2026-08-24T10:00:02.000Z'),
          ),
        ).resolves.toBe(1);
        await expect(
          transactionPersistence.deleteWebhookTransactions(
            workspaceId,
            started.syncRunId,
            account,
            [externalTransactionId],
            new Date('2026-08-24T10:00:03.000Z'),
          ),
        ).resolves.toBe(0);
        await transactionPersistence.completeSync(
          workspaceId,
          started.syncRunId,
          new Date('2026-08-24T10:00:04.000Z'),
        );
        const transactionState = await client.pool.query<{
          deleted_at: Date | null;
          revision_count: number;
          status: string;
        }>(
          `select ft.status, ft.deleted_at,
             (select count(*)::integer from transaction_revision tr
              where tr.workspace_id = ft.workspace_id
                and tr.financial_transaction_id = ft.id
                and tr.change_type = 'DELETE') as revision_count
           from financial_transaction ft
           where ft.workspace_id = $1 and ft.provider_transaction_id = $2`,
          [workspaceId, externalTransactionId],
        );
        expect(transactionState.rows[0]).toMatchObject({
          revision_count: 1,
          status: 'DELETED',
        });
        expect(transactionState.rows[0]?.deleted_at).toEqual(new Date('2026-08-24T10:00:02.000Z'));

        const payload = {
          event: 'item/waiting_user_input',
          eventId: '36000000-0000-4000-8000-000000000043',
          itemId: externalConnectionId,
          triggeredBy: 'SYNC',
        };
        const inbox = new WebhookInboxRepository(client.pool, encryption);
        await expect(
          inbox.ingestAuthenticatedPluggyWebhook(authenticatedWebhookIngestionCapability, {
            eventType: payload.event,
            externalAccountId: null,
            externalConnectionId,
            externalEventId: payload.eventId,
            payload,
            receivedAt: new Date('2026-08-24T11:00:00.000Z'),
          }),
        ).resolves.toEqual({ duplicate: false, mapped: true });
        const inboxRow = await client.pool.query<{ id: string }>(
          `select id from webhook_event where workspace_id = $1 and external_event_id = $2`,
          [workspaceId, payload.eventId],
        );
        const webhookEventId = inboxRow.rows[0]?.id;
        if (webhookEventId === undefined) throw new Error('Expected a mapped webhook event.');
        const processing = new WebhookProcessingRepository(client.pool);
        let activeLocks = 0;
        let maximumActiveLocks = 0;
        await Promise.all(
          Array.from({ length: 4 }, () =>
            processing.withConnectionLock(workspaceId, externalConnectionId, async () => {
              activeLocks += 1;
              maximumActiveLocks = Math.max(maximumActiveLocks, activeLocks);
              await new Promise((resolve) => setTimeout(resolve, 5));
              activeLocks -= 1;
            }),
          ),
        );
        expect(maximumActiveLocks).toBe(1);
        await expect(processing.load(null, webhookEventId, encryption)).rejects.toBeInstanceOf(
          WebhookProcessingInvariantError,
        );
        await expect(
          processing.load(workspaceId, webhookEventId, encryption),
        ).resolves.toMatchObject({ payload, status: 'QUEUED', workspaceId });
        await processing.markConnectionSyncing(workspaceId, providerConnectionId);
        await Promise.all(
          Array.from({ length: 4 }, () =>
            processing.recordLifecycleAlert(
              workspaceId,
              providerConnectionId,
              webhookEventId,
              'USER_INPUT_REQUIRED',
            ),
          ),
        );
        await processing.markFailed(workspaceId, webhookEventId, 'SYNTHETIC_FAILURE');
        await expect(
          processing.load(workspaceId, webhookEventId, encryption),
        ).resolves.toMatchObject({ payload, status: 'FAILED' });
        await processing.markProcessed(workspaceId, webhookEventId);
        await processing.markProcessed(workspaceId, webhookEventId);

        const refresh = await new JobQueueRepository(client.pool).enqueueWorkspace(workspaceId, {
          dedupeKey: 'sync-connection:before-delete',
          jobType: 'SYNC_CONNECTION',
          maxAttempts: 3,
          payload: { providerConnectionId },
        });
        const accountRefresh = await new JobQueueRepository(client.pool).enqueueWorkspace(
          workspaceId,
          {
            dedupeKey: 'sync-account:before-delete',
            jobType: 'SYNC_ACCOUNT',
            maxAttempts: 3,
            payload: { financialAccountId },
          },
        );
        await processing.markConnectionDeleted(workspaceId, providerConnectionId);
        const lifecycle = await client.pool.query<{
          account_active: boolean;
          alert_count: number;
          attempt_count: number;
          connection_status: string;
          refresh_status: string;
          scoped_refresh_status: string;
          webhook_status: string;
        }>(
          `select
             (select local_status from provider_connection where workspace_id = $1 and id = $2)
               as connection_status,
             (select is_active from financial_account where workspace_id = $1 and id = $3)
               as account_active,
             (select status from job_queue where workspace_id = $1 and id = $4)
               as refresh_status,
             (select status from job_queue where workspace_id = $1 and id = $6)
               as scoped_refresh_status,
             (select status from webhook_event where workspace_id = $1 and id = $5)
               as webhook_status,
             (select attempt_count from webhook_event where workspace_id = $1 and id = $5)
               as attempt_count,
             (select count(*)::integer from audit_event
              where workspace_id = $1 and event_type = 'PROVIDER_CONNECTION_ACTION_REQUIRED'
                and details ->> 'webhookEventId' = $5::text) as alert_count`,
          [
            workspaceId,
            providerConnectionId,
            financialAccountId,
            refresh.id,
            webhookEventId,
            accountRefresh.id,
          ],
        );
        expect(lifecycle.rows[0]).toEqual({
          account_active: false,
          alert_count: 1,
          attempt_count: 2,
          connection_status: 'DELETED',
          refresh_status: 'DEAD',
          scoped_refresh_status: 'DEAD',
          webhook_status: 'PROCESSED',
        });
      } finally {
        await client.pool.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)}`);
      await admin.end();
    }
  }, 30_000);
});
