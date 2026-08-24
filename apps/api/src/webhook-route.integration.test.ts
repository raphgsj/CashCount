import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import {
  createWebhookDatabasePool,
  PayloadEncryptionService,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
  WebhookInboxRepository,
} from '@cashcount/db/webhook';
import { describe, expect, it } from 'vitest';

import { processPluggyWebhookBody } from './webhook-route.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_webhook_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected webhook test database identifier.');
  }
  return `"${identifier}"`;
}

interface StoredWebhook {
  canonicalization_version: string;
  event_type: string;
  external_account_id: null | string;
  external_event_id: string;
  id: string;
  key_version: number;
  payload_ciphertext: Buffer;
  payload_iv: Buffer;
  payload_sha256: string;
  payload_tag: Buffer;
  status: string;
  workspace_id: null | string;
}

describe('Pluggy webhook route integration', () => {
  it('maps stored identities, encrypts and deduplicates the inbox, and queues only internal IDs', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_webhook_${randomUUID().replaceAll('-', '')}`;
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
        const itemId = '50000000-0000-4000-8000-000000000001';
        const connection = await client.query<{ id: string }>(
          `insert into provider_connection (
             workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, 'PLUGGY', $2, '601', 'Synthetic Webhook Bank')
           returning id`,
          [workspaceId, itemId],
        );
        const providerConnectionId = connection.rows[0]?.id;
        if (providerConnectionId === undefined) throw new Error('Expected provider connection.');
        const externalAccountId = '51000000-0000-4000-8000-000000000001';
        await client.query(
          `insert into financial_account (
             workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency
           ) values ($1, $2, 'PLUGGY', $3, 'CHECKING', 'Synthetic Checking',
                     'Synthetic Webhook Bank', 'BRL')`,
          [workspaceId, providerConnectionId, externalAccountId],
        );
        const encryption = new PayloadEncryptionService({
          activeKeyVersion: 7,
          keyring: new Map([[7, new Uint8Array(32).fill(61)]]),
        });
        const dependencies = {
          inbox: new WebhookInboxRepository(client, encryption),
          now: () => new Date('2026-08-23T23:00:00.000Z'),
          webhookSecret: 'synthetic-webhook-secret-for-test-boundary-only',
        };
        const mappedPayload = {
          event: 'item/updated',
          eventId: '60000000-0000-4000-8000-000000000001',
          itemId,
          triggeredBy: 'SYNC',
        };
        const authorization = `Bearer ${dependencies.webhookSecret}`;

        const duplicateResults = await Promise.all(
          Array.from({ length: 4 }, () =>
            processPluggyWebhookBody(
              authorization,
              Buffer.from(JSON.stringify(mappedPayload)),
              dependencies,
            ),
          ),
        );
        expect(duplicateResults.map(({ status }) => status)).toEqual([202, 202, 202, 202]);

        const mapped = await client.query<StoredWebhook>(
          `select * from webhook_event where external_event_id = $1`,
          [mappedPayload.eventId],
        );
        expect(mapped.rowCount).toBe(1);
        const stored = mapped.rows[0];
        if (stored === undefined) throw new Error('Expected mapped webhook evidence.');
        expect(stored).toMatchObject({
          key_version: 7,
          status: 'QUEUED',
          workspace_id: workspaceId,
        });
        expect(stored.payload_ciphertext.includes(Buffer.from('item/updated'))).toBe(false);
        if (stored.canonicalization_version !== 'CASHCOUNT_JSON_V1') {
          throw new Error('Unexpected webhook canonicalization version.');
        }
        expect(
          encryption.decryptJson(
            {
              authenticationTag: stored.payload_tag,
              canonicalizationVersion: stored.canonicalization_version,
              ciphertext: stored.payload_ciphertext,
              keyVersion: stored.key_version,
              nonce: stored.payload_iv,
              payloadSha256: stored.payload_sha256,
            },
            {
              entityType: stored.event_type,
              externalId: stored.external_event_id,
              provider: 'PLUGGY',
              recordId: stored.id,
              storageTable: 'webhook_event',
              workspaceId,
            },
          ),
        ).toEqual(mappedPayload);

        const transactionPayload = {
          accountId: externalAccountId,
          createdTransactionsLinkV2: `https://api.pluggy.ai/v2/transactions?accountId=${externalAccountId}&createdAtFrom=2026-08-24T11:00:00.000Z`,
          event: 'transactions/created',
          eventId: '60000000-0000-4000-8000-000000000003',
          itemId,
          transactionsCount: 1,
          transactionsCreatedAtFrom: '2026-08-24T11:00:00.000Z',
        };
        await processPluggyWebhookBody(
          authorization,
          Buffer.from(JSON.stringify(transactionPayload)),
          dependencies,
        );
        const mappedTransaction = await client.query<StoredWebhook>(
          `select * from webhook_event where external_event_id = $1`,
          [transactionPayload.eventId],
        );
        expect(mappedTransaction.rows[0]).toMatchObject({
          external_account_id: externalAccountId,
          status: 'QUEUED',
          workspace_id: workspaceId,
        });

        const unknownPayload = {
          ...mappedPayload,
          eventId: '60000000-0000-4000-8000-000000000002',
          itemId: '50000000-0000-4000-8000-000000000099',
        };
        await processPluggyWebhookBody(
          authorization,
          Buffer.from(JSON.stringify(unknownPayload)),
          dependencies,
        );
        const unmapped = await client.query<{ status: string; workspace_id: null }>(
          `select workspace_id, status from webhook_event where external_event_id = $1`,
          [unknownPayload.eventId],
        );
        expect(unmapped.rows).toEqual([{ status: 'UNMAPPED', workspace_id: null }]);

        const secondWorkspaceId = '20000000-0000-4000-8000-000000000002';
        await client.query(`insert into workspace (id, name) values ($1, 'Ambiguous Workspace')`, [
          secondWorkspaceId,
        ]);
        await client.query(
          `insert into provider_connection (
             workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, 'PLUGGY', $2, '602', 'Ambiguous Synthetic Bank')`,
          [secondWorkspaceId, itemId],
        );
        const ambiguousPayload = {
          ...mappedPayload,
          eventId: '60000000-0000-4000-8000-000000000004',
        };
        await processPluggyWebhookBody(
          authorization,
          Buffer.from(JSON.stringify(ambiguousPayload)),
          dependencies,
        );
        const ambiguous = await client.query<{ status: string; workspace_id: null }>(
          `select workspace_id, status from webhook_event where external_event_id = $1`,
          [ambiguousPayload.eventId],
        );
        expect(ambiguous.rows).toEqual([{ status: 'UNMAPPED', workspace_id: null }]);

        const workspaceJobs = await client.query<{
          payload: Record<string, unknown>;
          status: string;
          workspace_id: string;
        }>(`select workspace_id, status, payload from job_queue where workspace_id = $1`, [
          workspaceId,
        ]);
        expect(workspaceJobs.rows).toHaveLength(2);
        expect(workspaceJobs.rows.every(({ status }) => status === 'PENDING')).toBe(true);
        expect(
          workspaceJobs.rows.every(
            ({ payload }) => Object.keys(payload).join(',') === 'webhookEventId',
          ),
        ).toBe(true);
        const systemJob = await client.query<{ payload: Record<string, unknown> }>(
          `select payload from job_queue where workspace_id is null`,
        );
        expect(systemJob.rows).toHaveLength(2);
        expect(
          systemJob.rows.every(
            ({ payload }) => Object.keys(payload).join(',') === 'webhookEventId',
          ),
        ).toBe(true);
      } finally {
        await client.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)} with (force)`);
      await admin.end();
    }
  }, 30_000);
});
