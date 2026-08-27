import { randomUUID } from 'node:crypto';

import { AnomalyForecastRepository } from '@cashcount/analytics';
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
  if (!/^cashcount_anomaly_forecast_api_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected anomaly database identifier.');
  }
  return `"${identifier}"`;
}

describe('anomaly candidates and forecast API integration', () => {
  it('returns all transparent candidate rules and a currency-safe explainable forecast', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_anomaly_forecast_api_${randomUUID().replaceAll('-', '')}`;
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
        const connectionId = '21000000-0000-4000-8000-000000000069';
        const accountId = '31000000-0000-4000-8000-000000000069';
        const spikeMerchantId = '41000000-0000-4000-8000-000000000069';
        const recurringMerchantId = '41000000-0000-4000-8000-000000000070';
        const candidateMerchantId = '41000000-0000-4000-8000-000000000071';
        const categoryId = '51000000-0000-4000-8000-000000000069';

        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id,
             display_name, local_status, last_successful_sync_at
           ) values ($1, $2, 'PLUGGY', 'anomaly-private-item', 'synthetic',
             'Synthetic Bank', 'ACTIVE', '2026-08-27T11:00:00Z')`,
          [connectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency, masked_number,
             last_successful_sync_at, provider_history_earliest_date,
             provider_history_latest_date, initial_import_completed_at, history_coverage_status
           ) values ($1, $2, $3, 'PLUGGY', 'anomaly-private-account', 'CHECKING',
             'Synthetic Account', 'Synthetic Bank', 'BRL', '9876', '2026-08-27T11:00:00Z',
             '2026-01-01', '2026-08-27', '2026-08-27T11:00:00Z',
             'PROVIDER_MAXIMUM_RETRIEVED')`,
          [accountId, workspaceId, connectionId],
        );
        await client.query(
          `insert into category (
             id, workspace_id, code, kind, name_en, name_pt_br
           ) values ($1, $2, $3, 'EXPENSE', 'Synthetic Expense', 'Despesa sintética')`,
          [categoryId, workspaceId, `custom.${categoryId}`],
        );
        await client.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key, review_status)
           values ($1, $4, 'Baseline Store', 'baseline store', 'CONFIRMED'),
             ($2, $4, 'Recurring Service', 'recurring service', 'CONFIRMED'),
             ($3, $4, 'New Subscription', 'new subscription', 'CONFIRMED')`,
          [spikeMerchantId, recurringMerchantId, candidateMerchantId, workspaceId],
        );

        const insertTransaction = (input: {
          amount: string;
          date: string;
          id: string;
          merchantId: string;
          providerId: string;
        }) =>
          client.query(
            `insert into financial_transaction (
               id, workspace_id, financial_account_id, provider, provider_transaction_id,
               status, provider_type, provider_amount_signed, provider_currency,
               account_currency_amount_signed, account_currency, system_direction,
               system_financial_role, provider_transaction_at, transaction_local_date,
               description_original, description_normalized, system_category_id,
               system_category_source, system_merchant_id, system_merchant_source,
               system_financial_role_source, system_exclusion_source, dedupe_fingerprint
             ) values ($1, $2, $3, 'PLUGGY', $4, 'POSTED', 'DEBIT', $5, 'BRL', $5,
               'BRL', 'OUTFLOW', 'PURCHASE', ($6::date + time '12:00') at time zone 'UTC',
               $6, $7, lower($7), $8, 'HEURISTIC', $9, 'MERCHANT', 'HEURISTIC', 'POLICY',
               repeat(md5($4), 2))`,
            [
              input.id,
              workspaceId,
              accountId,
              input.providerId,
              `-${input.amount}`,
              input.date,
              `Synthetic ${input.providerId}`,
              categoryId,
              input.merchantId,
            ],
          );

        const transactions = [
          [
            '61000000-0000-4000-8000-000000000061',
            'base-may',
            '2026-05-01',
            '100.000000',
            spikeMerchantId,
          ],
          [
            '61000000-0000-4000-8000-000000000062',
            'base-jun',
            '2026-06-01',
            '100.000000',
            spikeMerchantId,
          ],
          [
            '61000000-0000-4000-8000-000000000063',
            'base-jul',
            '2026-07-01',
            '100.000000',
            spikeMerchantId,
          ],
          [
            '61000000-0000-4000-8000-000000000064',
            'spike-aug',
            '2026-08-10',
            '200.000000',
            spikeMerchantId,
          ],
          [
            '61000000-0000-4000-8000-000000000065',
            'rec-jun',
            '2026-06-05',
            '100.000000',
            recurringMerchantId,
          ],
          [
            '61000000-0000-4000-8000-000000000066',
            'rec-jul',
            '2026-07-05',
            '100.000000',
            recurringMerchantId,
          ],
          [
            '61000000-0000-4000-8000-000000000067',
            'rec-aug',
            '2026-08-05',
            '150.000000',
            recurringMerchantId,
          ],
          [
            '61000000-0000-4000-8000-000000000068',
            'duplicate-one',
            '2026-08-20',
            '50.000000',
            spikeMerchantId,
          ],
          [
            '61000000-0000-4000-8000-000000000069',
            'duplicate-two',
            '2026-08-21',
            '50.000000',
            spikeMerchantId,
          ],
        ] as const;
        for (const [id, providerId, date, amount, merchantId] of transactions) {
          await insertTransaction({ amount, date, id, merchantId, providerId });
        }

        await client.query(
          `insert into recurring_series (
             workspace_id, merchant_id, category_id, cadence, expected_interval_days,
             currency, amount_min, amount_max, amount_average, last_occurrence_date,
             next_expected_date, confidence, status, created_at
           ) values
             ($1, $2, $4, 'MONTHLY', 30, 'BRL', 100, 150, 100, '2026-08-05',
               '2026-08-29', 0.9000, 'CONFIRMED', '2026-08-01T00:00:00Z'),
             ($1, $3, $4, 'MONTHLY', 30, 'BRL', 30, 30, 30, '2026-08-15',
               '2026-09-14', 0.8500, 'CANDIDATE', '2026-08-20T00:00:00Z')`,
          [workspaceId, recurringMerchantId, candidateMerchantId, categoryId],
        );
        await client.query(
          `insert into installment_series (
             workspace_id, financial_account_id, merchant_id, currency, total_installments,
             highest_confirmed_installment, estimated_installment_amount,
             original_total_amount, purchase_date, status
           ) values ($1, $2, $3, 'BRL', 3, 1, 20, 60, '2026-07-10', 'CONFIRMED')`,
          [workspaceId, accountId, spikeMerchantId],
        );

        const webToken = 'synthetic-web-token-anomaly-forecast-00000000000000001';
        const mcpToken = 'synthetic-mcp-token-anomaly-forecast-00000000000000001';
        const webhookToken = 'synthetic-webhook-token-anomaly-forecast-0000000000001';
        const repository = new AnomalyForecastRepository(client);
        await repository.anomalies(workspaceId, new Date('2026-08-27T12:00:00Z'));
        await repository.forecast(workspaceId, new Date('2026-08-27T12:00:00Z'));
        const server = createApiServer({
          anomalyForecast: {
            mcpToken,
            now: () => new Date('2026-08-27T12:00:00Z'),
            repository,
            webToken,
            workspaceId,
          },
          inbox: {
            ingestAuthenticatedPluggyWebhook: async () => {
              throw new Error('Webhook must not run during analytics reads.');
            },
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
          const anomalies = await get('/v1/analytics/anomaly-candidates', mcpToken);
          expect(anomalies.statusCode).toBe(200);
          expect(anomalies.json()).toMatchObject({
            data: {
              asOf: '2026-08-27',
              candidates: expect.arrayContaining([
                expect.objectContaining({ rule: 'MERCHANT_AMOUNT_SPIKE', status: 'CANDIDATE' }),
                expect.objectContaining({ rule: 'CATEGORY_SPEND_SPIKE' }),
                expect.objectContaining({ rule: 'DUPLICATE_LIKE_CHARGE' }),
                expect.objectContaining({ rule: 'NEW_RECURRING_MERCHANT' }),
                expect.objectContaining({ rule: 'RECURRING_AMOUNT_INCREASE' }),
              ]),
            },
            meta: { policyVersion: 1, workspaceId },
            warnings: expect.arrayContaining([
              expect.objectContaining({ code: 'ESTIMATED_ANOMALIES' }),
            ]),
          });
          expect(anomalies.body).not.toMatch(/fraud|private|9876|61000000-/iu);

          const forecast = await get('/v1/analytics/month-forecast', webToken);
          expect(forecast.statusCode).toBe(200);
          expect(forecast.json()).toMatchObject({
            data: {
              asOf: '2026-08-27',
              currencies: [
                {
                  actualMonthToDate: { currency: 'BRL', value: '450.000000' },
                  commitmentFloorForecast: { value: '570.000000' },
                  confirmedInstallmentsRemaining: { value: '20.000000' },
                  confirmedRecurringRemaining: { value: '100.000000' },
                  forecastTotal: { value: '570.000000' },
                  knownCommitmentsRemaining: { value: '120.000000' },
                  runRateForecast: { value: '516.666667' },
                },
              ],
              monthEnd: '2026-08-31',
              monthStart: '2026-08-01',
            },
            warnings: expect.arrayContaining([
              expect.objectContaining({ code: 'ESTIMATED_FORECAST' }),
              expect.objectContaining({ code: 'COMMITMENTS_NOT_ADDITIVE' }),
            ]),
          });
          expect(forecast.body).not.toMatch(/private|9876|61000000-/iu);
          expect((await get('/v1/analytics/month-forecast', webhookToken)).statusCode).toBe(401);
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
