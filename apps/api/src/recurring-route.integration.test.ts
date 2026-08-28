import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { RecurringRepository } from '@cashcount/db/finance';
import {
  createWebhookDatabasePool,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
} from '@cashcount/db/webhook';
import { describe, expect, it } from 'vitest';

import { createApiServer } from './api-server.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_recurring_api_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected recurring database identifier.');
  }
  return `"${identifier}"`;
}

describe('recurring detector API integration', () => {
  it('creates review-only deterministic candidates and audits explicit confirmation', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_recurring_api_${randomUUID().replaceAll('-', '')}`;
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
        const connectionId = '23000000-0000-4000-8000-000000000068';
        const accountId = '33000000-0000-4000-8000-000000000068';
        const merchantId = '43000000-0000-4000-8000-000000000068';
        const irregularMerchantId = '43000000-0000-4000-8000-000000000069';

        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id,
             display_name, local_status, last_successful_sync_at
           ) values ($1, $2, 'PLUGGY', 'recurring-private-item', 'synthetic',
             'Synthetic Bank', 'ACTIVE', current_timestamp)`,
          [connectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency, masked_number,
             last_successful_sync_at
           ) values ($1, $2, $3, 'PLUGGY', 'recurring-account-private', 'CHECKING',
             'Synthetic Checking', 'Synthetic Bank', 'BRL', '1234', current_timestamp)`,
          [accountId, workspaceId, connectionId],
        );
        await client.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key, review_status)
           values ($1, $3, 'Synthetic Subscription', 'synthetic subscription', 'CONFIRMED'),
             ($2, $3, 'Irregular Merchant', 'irregular merchant', 'CONFIRMED')`,
          [merchantId, irregularMerchantId, workspaceId],
        );

        const insertPurchase = (
          id: string,
          targetMerchantId: string,
          date: string,
          amount: string,
        ) =>
          client.query(
            `insert into financial_transaction (
               id, workspace_id, financial_account_id, provider, provider_transaction_id,
               status, provider_type, provider_amount_signed, provider_currency,
               account_currency_amount_signed, account_currency, system_direction,
               system_financial_role, provider_transaction_at, transaction_local_date,
               description_original, description_normalized, system_merchant_id,
               system_merchant_source, system_financial_role_source, system_exclusion_source,
               dedupe_fingerprint
             ) values ($1, $2, $3, 'PLUGGY', $4, 'POSTED', 'DEBIT', $5, 'BRL', $5,
               'BRL', 'OUTFLOW', 'PURCHASE', ($6::date + time '12:00') at time zone 'UTC',
               $6, 'Synthetic recurring', 'synthetic recurring', $7, 'MERCHANT',
               'HEURISTIC', 'POLICY', repeat(md5($4), 2))`,
            [id, workspaceId, accountId, `private-${id}`, amount, date, targetMerchantId],
          );

        await insertPurchase(
          '63000000-0000-4000-8000-000000000068',
          merchantId,
          '2026-06-01',
          '-100.000000',
        );
        await insertPurchase(
          '63000000-0000-4000-8000-000000000069',
          merchantId,
          '2026-07-01',
          '-101.000000',
        );
        await insertPurchase(
          '63000000-0000-4000-8000-000000000070',
          merchantId,
          '2026-08-01',
          '-99.000000',
        );
        await insertPurchase(
          '63000000-0000-4000-8000-000000000071',
          irregularMerchantId,
          '2026-06-01',
          '-50.000000',
        );
        await insertPurchase(
          '63000000-0000-4000-8000-000000000072',
          irregularMerchantId,
          '2026-06-10',
          '-50.000000',
        );
        await insertPurchase(
          '63000000-0000-4000-8000-000000000073',
          irregularMerchantId,
          '2026-08-25',
          '-50.000000',
        );

        const webToken = 'synthetic-web-token-recurring-00000000000000000001';
        const mcpToken = 'synthetic-mcp-token-recurring-00000000000000000001';
        const webhookToken = 'synthetic-webhook-token-recurring-0000000000000001';
        const repository = new RecurringRepository(client);
        const server = createApiServer({
          inbox: {
            ingestAuthenticatedPluggyWebhook: async () => {
              throw new Error('Webhook must not run during recurring detection.');
            },
          },
          mcpToken,
          nodeEnvironment: 'test',
          recurring: { mcpToken, repository, webToken, workspaceId },
          webhookSecret: webhookToken,
          workspaceId,
        });
        try {
          const inject = (input: { body?: { actorId: string }; path: string; token?: string }) =>
            input.body === undefined
              ? server.inject({
                  headers: { authorization: `Bearer ${input.token ?? webToken}` },
                  method: 'GET',
                  url: input.path,
                })
              : server.inject({
                  headers: { authorization: `Bearer ${input.token ?? webToken}` },
                  method: 'POST',
                  payload: input.body,
                  url: input.path,
                });

          const detected = await inject({
            body: { actorId: 'synthetic-owner' },
            path: '/v1/recurring-expenses/detect',
          });
          expect(detected.statusCode).toBe(200);
          expect(detected.json().data.candidateCount).toBe(1);
          expect(
            (
              await inject({
                body: { actorId: 'synthetic-owner' },
                path: '/v1/recurring-expenses/detect',
              })
            ).json().data.candidateCount,
          ).toBe(0);

          const analyticsCandidate = await inject({
            path: '/v1/analytics/recurring-expenses',
            token: mcpToken,
          });
          expect(analyticsCandidate.statusCode).toBe(200);
          expect(analyticsCandidate.json()).toMatchObject({
            data: {
              monthlyBaseline: [],
              series: [
                {
                  amountAverage: { currency: 'BRL', value: '100.000000' },
                  cadence: 'MONTHLY',
                  expectedIntervalDays: 30,
                  merchantLabel: 'Synthetic Subscription',
                  observationCount: 3,
                  priceChangePercent: '-1.000000',
                  status: 'CANDIDATE',
                },
              ],
            },
            meta: { policyVersion: 1, workspaceId },
          });
          expect(JSON.stringify(analyticsCandidate.json().data)).not.toMatch(
            /private|1234|[0-9a-f]{8}-0000-4000/iu,
          );

          const review = await inject({ path: '/v1/recurring-series' });
          expect(review.statusCode).toBe(200);
          const recurringId = review.json().data.series[0].id as string;
          const confirmed = await inject({
            body: { actorId: 'synthetic-owner' },
            path: `/v1/recurring-series/${recurringId}/confirm`,
          });
          expect(confirmed.statusCode).toBe(200);
          expect(confirmed.json().data.status).toBe('CONFIRMED');
          const repeatedConfirmation = await inject({
            body: { actorId: 'synthetic-owner' },
            path: `/v1/recurring-series/${recurringId}/confirm`,
          });
          expect(repeatedConfirmation.statusCode).toBe(200);
          expect(repeatedConfirmation.json().data.status).toBe('CONFIRMED');

          const analyticsConfirmed = await inject({
            path: '/v1/analytics/recurring-expenses',
            token: mcpToken,
          });
          expect(analyticsConfirmed.json()).toMatchObject({
            data: {
              monthlyBaseline: [{ amount: { currency: 'BRL', value: '100.000000' } }],
              series: [{ status: 'CONFIRMED' }],
            },
            warnings: [{ code: 'ESTIMATED_RECURRING_BASELINE' }],
          });
          expect(
            (
              await inject({
                body: { actorId: 'synthetic-owner' },
                path: `/v1/recurring-series/${recurringId}/reject`,
                token: mcpToken,
              })
            ).statusCode,
          ).toBe(401);
          expect(
            Number(
              (
                await client.query(
                  `select count(*)::integer as count from audit_event
                   where workspace_id = $1 and event_type in (
                     'RECURRING_DETECTION_RUN', 'RECURRING_SERIES_CONFIRMED'
                   )`,
                  [workspaceId],
                )
              ).rows[0]?.count,
            ),
          ).toBe(2);
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
