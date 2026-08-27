import { randomUUID } from 'node:crypto';

import { InstallmentCommitmentsRepository } from '@cashcount/analytics';
import { parseDatabaseConfig } from '@cashcount/config';
import {
  createWebhookDatabasePool,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
} from '@cashcount/db/webhook';
import { describe, expect, it } from 'vitest';

import { createApiServer } from './api-server.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_installments_api_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected installment database identifier.');
  }
  return `"${identifier}"`;
}

describe('installment commitments API integration', () => {
  it('returns only confirmed currency-safe estimates while keeping review states web-only', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_installments_api_${randomUUID().replaceAll('-', '')}`;
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
        const connectionId = '22000000-0000-4000-8000-000000000067';
        const cardId = '32000000-0000-4000-8000-000000000067';
        const merchantId = '42000000-0000-4000-8000-000000000067';
        const confirmedId = '52000000-0000-4000-8000-000000000067';
        const candidateId = '52000000-0000-4000-8000-000000000068';
        const unallocatedId = '52000000-0000-4000-8000-000000000069';

        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id,
             display_name, local_status, last_successful_sync_at
           ) values ($1, $2, 'PLUGGY', 'installment-private-item', 'synthetic',
             'Synthetic Bank', 'ACTIVE', '2026-08-27T00:00:00Z')`,
          [connectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency, masked_number,
             last_successful_sync_at
           ) values ($1, $2, $3, 'PLUGGY', 'installment-card-private', 'CREDIT_CARD',
             'Synthetic Card', 'Synthetic Bank', 'BRL', '9876', '2026-08-27T00:00:00Z')`,
          [cardId, workspaceId, connectionId],
        );
        await client.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key, review_status)
           values ($1, $2, 'Synthetic Store', 'synthetic store', 'CONFIRMED')`,
          [merchantId, workspaceId],
        );
        await client.query(
          `insert into installment_series (
             id, workspace_id, financial_account_id, merchant_id, currency,
             total_installments, highest_confirmed_installment, estimated_installment_amount,
             original_total_amount, purchase_date, status
           ) values
             ($1, $4, $5, $6, 'BRL', 6, 2, 100.000001, 600.000006, '2026-06-10', 'CONFIRMED'),
             ($2, $4, $5, $6, 'BRL', 3, 1, 50.000000, 150.000000, '2026-07-12', 'CANDIDATE'),
             ($3, $4, $5, $6, 'USD', 4, 1, null, null, null, 'CONFIRMED')`,
          [confirmedId, candidateId, unallocatedId, workspaceId, cardId, merchantId],
        );

        const webToken = 'synthetic-web-token-installments-0000000000000000001';
        const mcpToken = 'synthetic-mcp-token-installments-0000000000000000001';
        const webhookToken = 'synthetic-webhook-token-installments-000000000000001';
        const server = createApiServer({
          inbox: {
            ingestAuthenticatedPluggyWebhook: async () => {
              throw new Error('Webhook must not run during installment reads.');
            },
          },
          installments: {
            mcpToken,
            repository: new InstallmentCommitmentsRepository(client),
            webToken,
            workspaceId,
          },
          mcpToken,
          nodeEnvironment: 'test',
          webhookSecret: webhookToken,
          workspaceId,
        });
        try {
          const get = (path: string, token: string) =>
            server.inject({
              headers: { authorization: `Bearer ${token}` },
              method: 'GET',
              url: path,
            });
          const analytics = await get('/v1/analytics/installment-commitments', mcpToken);
          expect(analytics.statusCode).toBe(200);
          expect(analytics.json()).toMatchObject({
            data: {
              includeReviewStates: false,
              monthly: [
                {
                  estimatedAmount: { currency: 'BRL', value: '100.000001' },
                  estimatedInstallmentCount: 1,
                  month: '2026-08-01',
                },
                { estimatedAmount: { value: '100.000001' }, month: '2026-09-01' },
                { estimatedAmount: { value: '100.000001' }, month: '2026-10-01' },
                { estimatedAmount: { value: '100.000001' }, month: '2026-11-01' },
              ],
              series: expect.arrayContaining([
                expect.objectContaining({
                  estimatedRemainingCommitment: { currency: 'BRL', value: '400.000004' },
                  merchantLabel: 'Synthetic Store',
                  remainingInstallments: 4,
                  status: 'CONFIRMED',
                }),
                expect.objectContaining({
                  estimatedRemainingCommitment: null,
                  remainingInstallments: 3,
                  status: 'CONFIRMED',
                }),
              ]),
            },
            meta: { policyVersion: 1, workspaceId },
            warnings: expect.arrayContaining([
              expect.objectContaining({ code: 'ESTIMATED_COMMITMENTS' }),
              expect.objectContaining({ affectedSeriesCount: 1, code: 'UNALLOCATED_INSTALLMENTS' }),
            ]),
          });
          expect(analytics.body).not.toMatch(/private|9876|52000000-/iu);
          expect(analytics.body).not.toContain('CANDIDATE');

          const card = await get(`/v1/cards/${cardId}/installments`, webToken);
          expect(card.statusCode).toBe(200);
          expect(card.json().data).toMatchObject({ includeReviewStates: true });
          expect(card.json().data.series).toEqual(
            expect.arrayContaining([expect.objectContaining({ status: 'CANDIDATE' })]),
          );
          expect((await get(`/v1/cards/${cardId}/installments`, mcpToken)).statusCode).toBe(401);
        } finally {
          await server.close();
        }
      } finally {
        await client.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)}`);
      await admin.end();
    }
  }, 45_000);
});
