import { randomUUID } from 'node:crypto';

import { SpendingCashFlowAnalyticsRepository } from '@cashcount/analytics';
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
  if (!/^cashcount_spending_api_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected spending API database identifier.');
  }
  return `"${identifier}"`;
}

describe('spending and cash-flow analytics integration', () => {
  it('returns exact effective count-once totals and all applicable warnings by workspace', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_spending_api_${randomUUID().replaceAll('-', '')}`;
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
        const otherWorkspaceId = '10000000-0000-4000-8000-000000000065';
        const connectionId = '20000000-0000-4000-8000-000000000065';
        const otherConnectionId = '20000000-0000-4000-8000-000000000066';
        const checkingId = '30000000-0000-4000-8000-000000000065';
        const cardId = '30000000-0000-4000-8000-000000000066';
        const otherAccountId = '30000000-0000-4000-8000-000000000067';
        const categoryAId = '40000000-0000-4000-8000-000000000065';
        const categoryBId = '40000000-0000-4000-8000-000000000066';
        const otherCategoryId = '40000000-0000-4000-8000-000000000067';
        const merchantId = '50000000-0000-4000-8000-000000000065';
        const otherMerchantId = '50000000-0000-4000-8000-000000000066';
        const billId = '60000000-0000-4000-8000-000000000065';
        const purchaseId = '70000000-0000-4000-8000-000000000065';
        const cardPurchaseId = '70000000-0000-4000-8000-000000000066';
        const refundId = '70000000-0000-4000-8000-000000000067';
        const incomeId = '70000000-0000-4000-8000-000000000068';
        const transferId = '70000000-0000-4000-8000-000000000069';
        const bankPaymentId = '70000000-0000-4000-8000-000000000070';
        const cardPaymentId = '70000000-0000-4000-8000-000000000071';
        const feeId = '70000000-0000-4000-8000-000000000072';
        const pendingId = '70000000-0000-4000-8000-000000000073';
        const duplicateId = '70000000-0000-4000-8000-000000000074';
        const excludedId = '70000000-0000-4000-8000-000000000075';
        const unconvertedId = '70000000-0000-4000-8000-000000000076';
        const otherTransactionId = '70000000-0000-4000-8000-000000000077';
        const billPaymentId = '80000000-0000-4000-8000-000000000065';
        const financeChargeId = '90000000-0000-4000-8000-000000000065';

        await client.query(`insert into workspace (id, name) values ($1, 'Other Analytics')`, [
          otherWorkspaceId,
        ]);
        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id,
             display_name, local_status, last_successful_sync_at
           ) values
             ($1, $3, 'PLUGGY', 'analytics-private-item', 'synthetic', 'Analytics Bank',
              'PROVIDER_ERROR', '2026-08-20T12:00:00Z'),
             ($2, $4, 'PLUGGY', 'other-analytics-private-item', 'synthetic', 'Other Bank',
              'ACTIVE', '2026-08-27T00:00:00Z')`,
          [connectionId, otherConnectionId, workspaceId, otherWorkspaceId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id, account_type,
             name, institution_name, currency, masked_number, last_successful_sync_at,
             provider_history_earliest_date, provider_history_latest_date, history_coverage_status
           ) values
             ($1, $4, $6, 'PLUGGY', 'analytics-checking-private', 'CHECKING',
              'Synthetic Checking', 'Analytics Bank', 'BRL', '1234', '2026-08-20T12:00:00Z',
              '2026-08-10', '2026-08-26', 'PARTIAL'),
             ($2, $4, $6, 'PLUGGY', 'analytics-card-private', 'CREDIT_CARD',
              'Synthetic Card', 'Analytics Bank', 'BRL', '9876', '2026-08-20T12:00:00Z',
              '2026-08-10', '2026-08-26', 'PARTIAL'),
             ($3, $5, $7, 'PLUGGY', 'other-analytics-private', 'CHECKING',
              'Other Checking', 'Other Bank', 'BRL', '1111', '2026-08-27T00:00:00Z',
              '2026-01-01', '2026-08-27', 'PROVIDER_MAXIMUM_RETRIEVED')`,
          [
            checkingId,
            cardId,
            otherAccountId,
            workspaceId,
            otherWorkspaceId,
            connectionId,
            otherConnectionId,
          ],
        );
        await client.query(
          `insert into category (id, workspace_id, code, kind, name_en, name_pt_br) values
             ($1, $4, 'custom.40000000-0000-4000-8000-000000000065', 'EXPENSE',
              'Original category', 'Categoria original'),
             ($2, $4, 'custom.40000000-0000-4000-8000-000000000066', 'EXPENSE',
              'Owner category', 'Categoria da pessoa'),
             ($3, $5, 'custom.40000000-0000-4000-8000-000000000067', 'EXPENSE',
              'Other category', 'Outra categoria')`,
          [categoryAId, categoryBId, otherCategoryId, workspaceId, otherWorkspaceId],
        );
        await client.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key, review_status)
           values
             ($1, $3, 'Synthetic Market', 'synthetic market', 'CONFIRMED'),
             ($2, $4, 'Other Market', 'other market', 'CONFIRMED')`,
          [merchantId, otherMerchantId, workspaceId, otherWorkspaceId],
        );
        await client.query(
          `insert into credit_card_bill (
             id, workspace_id, financial_account_id, provider, external_bill_id, status,
             due_date, close_date, total_amount, minimum_payment, currency
           ) values ($1, $2, $3, 'PLUGGY', 'analytics-bill-private', 'OPEN',
                     '2026-08-30', '2026-08-20', 390.000000, 39.000000, 'BRL')`,
          [billId, workspaceId, cardId],
        );

        const insertTransaction = (input: {
          accountAmount?: null | string;
          accountCurrency?: string;
          accountId: string;
          amount: string;
          billId?: string;
          categoryId?: string;
          date: string;
          direction: string;
          duplicateStatus?: string;
          excluded?: boolean;
          id: string;
          merchantId?: string;
          providerCurrency?: string;
          providerId: string;
          role: string;
          status?: string;
          workspaceId: string;
        }) =>
          client.query(
            `insert into financial_transaction (
               id, workspace_id, financial_account_id, provider, provider_transaction_id, status,
               provider_type, provider_amount_signed, provider_currency,
               account_currency_amount_signed, account_currency, system_direction,
               system_financial_role, system_is_excluded_from_spend, provider_transaction_at,
               transaction_local_date, description_original, description_normalized,
               system_category_id, system_category_source, system_merchant_id,
               system_merchant_source, system_financial_role_source, system_exclusion_source,
               credit_card_bill_id, duplicate_review_status, dedupe_fingerprint
             ) values (
               $1, $2, $3, 'PLUGGY', $4, $5, 'DEBIT', $6, $7, $8, $9, $10, $11, $12,
               ($13::date + time '12:00') at time zone 'UTC', $13, $14, lower($14), $15,
               case when $15::uuid is null then 'NONE' else 'HEURISTIC' end, $16,
               case when $16::uuid is null then 'NONE' else 'MERCHANT' end,
               'HEURISTIC', 'POLICY', $17, $18, repeat(md5($4), 2)
             )`,
            [
              input.id,
              input.workspaceId,
              input.accountId,
              input.providerId,
              input.status ?? 'POSTED',
              input.amount,
              input.providerCurrency ?? 'BRL',
              input.accountAmount === undefined ? input.amount : input.accountAmount,
              input.accountCurrency ?? 'BRL',
              input.direction,
              input.role,
              input.excluded ?? false,
              input.date,
              `Synthetic ${input.providerId}`,
              input.categoryId ?? null,
              input.merchantId ?? null,
              input.billId ?? null,
              input.duplicateStatus ?? 'NONE',
            ],
          );

        await insertTransaction({
          accountId: checkingId,
          amount: '-100.000001',
          categoryId: categoryAId,
          date: '2026-08-05',
          direction: 'OUTFLOW',
          id: purchaseId,
          merchantId,
          providerId: 'checking-purchase-private',
          role: 'PURCHASE',
          workspaceId,
        });
        await insertTransaction({
          accountId: cardId,
          amount: '200.000002',
          billId,
          categoryId: categoryAId,
          date: '2026-08-06',
          direction: 'OUTFLOW',
          id: cardPurchaseId,
          merchantId,
          providerId: 'card-purchase-private',
          role: 'PURCHASE',
          workspaceId,
        });
        await insertTransaction({
          accountId: cardId,
          amount: '-20.000003',
          categoryId: categoryAId,
          date: '2026-08-07',
          direction: 'INFLOW',
          id: refundId,
          merchantId,
          providerId: 'refund-private',
          role: 'REFUND',
          workspaceId,
        });
        await insertTransaction({
          accountId: checkingId,
          amount: '1000.000004',
          date: '2026-08-08',
          direction: 'INFLOW',
          id: incomeId,
          providerId: 'income-private',
          role: 'INCOME',
          workspaceId,
        });
        await insertTransaction({
          accountId: checkingId,
          amount: '-300.000005',
          date: '2026-08-09',
          direction: 'OUTFLOW',
          id: transferId,
          providerId: 'transfer-private',
          role: 'TRANSFER',
          workspaceId,
        });
        await insertTransaction({
          accountId: checkingId,
          amount: '-200.000006',
          date: '2026-08-10',
          direction: 'OUTFLOW',
          id: bankPaymentId,
          providerId: 'bank-payment-private',
          role: 'CARD_BILL_PAYMENT',
          workspaceId,
        });
        await insertTransaction({
          accountId: cardId,
          amount: '-200.000006',
          billId,
          date: '2026-08-10',
          direction: 'NEUTRAL',
          id: cardPaymentId,
          providerId: 'card-payment-private',
          role: 'CARD_BILL_PAYMENT',
          workspaceId,
        });
        await insertTransaction({
          accountId: cardId,
          amount: '5.000007',
          billId,
          categoryId: categoryAId,
          date: '2026-08-11',
          direction: 'OUTFLOW',
          id: feeId,
          providerId: 'fee-private',
          role: 'FEE',
          workspaceId,
        });
        await insertTransaction({
          accountId: checkingId,
          amount: '-10.000008',
          categoryId: categoryAId,
          date: '2026-08-12',
          direction: 'OUTFLOW',
          id: pendingId,
          providerId: 'pending-private',
          role: 'PURCHASE',
          status: 'PENDING',
          workspaceId,
        });
        await insertTransaction({
          accountId: checkingId,
          amount: '-99.000009',
          categoryId: categoryAId,
          date: '2026-08-13',
          direction: 'OUTFLOW',
          duplicateStatus: 'CONFIRMED_DUPLICATE',
          id: duplicateId,
          providerId: 'duplicate-private',
          role: 'PURCHASE',
          workspaceId,
        });
        await insertTransaction({
          accountId: checkingId,
          amount: '-50.000010',
          categoryId: categoryAId,
          date: '2026-08-14',
          direction: 'OUTFLOW',
          excluded: true,
          id: excludedId,
          providerId: 'excluded-private',
          role: 'PURCHASE',
          workspaceId,
        });
        await insertTransaction({
          accountAmount: null,
          accountId: checkingId,
          amount: '-12.000011',
          categoryId: categoryAId,
          date: '2026-08-15',
          direction: 'OUTFLOW',
          id: unconvertedId,
          providerCurrency: 'USD',
          providerId: 'unconverted-private',
          role: 'PURCHASE',
          workspaceId,
        });
        await insertTransaction({
          accountId: otherAccountId,
          amount: '-999.000000',
          categoryId: otherCategoryId,
          date: '2026-08-05',
          direction: 'OUTFLOW',
          id: otherTransactionId,
          merchantId: otherMerchantId,
          providerId: 'other-workspace-private',
          role: 'PURCHASE',
          workspaceId: otherWorkspaceId,
        });
        await client.query(
          `insert into transaction_user_state (
             financial_transaction_id, workspace_id, category_override_enabled,
             category_id_override, updated_by_actor_type, updated_by_actor_id
           ) values ($1, $2, true, $3, 'USER', 'synthetic-owner')`,
          [purchaseId, workspaceId, categoryBId],
        );
        await client.query(
          `insert into credit_card_bill_payment (
             id, workspace_id, credit_card_bill_id, provider, external_payment_id, value_type,
             payment_date, amount, currency, matched_card_transaction_id
           ) values ($1, $2, $3, 'PLUGGY', 'analytics-payment-private', 'FULL_PAYMENT',
                     '2026-08-10', 200.000006, 'BRL', $4)`,
          [billPaymentId, workspaceId, billId, cardPaymentId],
        );
        await client.query(
          `insert into credit_card_bill_finance_charge (
             id, workspace_id, credit_card_bill_id, provider, external_charge_id, charge_type,
             amount, currency, matched_transaction_id
           ) values ($1, $2, $3, 'PLUGGY', 'analytics-charge-private', 'INTEREST',
                     5.000007, 'BRL', $4)`,
          [financeChargeId, workspaceId, billId, feeId],
        );
        await client.query(
          `insert into bill_payment_reconciliation (
             workspace_id, credit_card_bill_payment_id, financial_transaction_id, match_status,
             match_method, confidence, matched_at, confirmed_by
           ) values ($1, $2, $3, 'USER_CONFIRMED', 'OWNER', 1, now(), 'synthetic-owner')`,
          [workspaceId, billPaymentId, bankPaymentId],
        );

        const webToken = 'synthetic-web-token-spending-boundary-000000000000001';
        const mcpToken = 'synthetic-mcp-token-spending-boundary-000000000000001';
        const webhookToken = 'synthetic-webhook-token-spending-boundary-000000001';
        const server = createApiServer({
          analytics: {
            mcpToken,
            repository: new SpendingCashFlowAnalyticsRepository(client),
            webToken,
            workspaceId,
          },
          inbox: {
            ingestAuthenticatedPluggyWebhook: async () => {
              throw new Error('Webhook must not be invoked by analytics reads.');
            },
          },
          mcpToken,
          nodeEnvironment: 'test',
          webhookSecret: webhookToken,
          workspaceId,
        });
        try {
          const get = (path: string, token = webToken) =>
            server.inject({
              headers: { authorization: `Bearer ${token}` },
              method: 'GET',
              url: path,
            });
          const posted = await get(
            '/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31&granularity=DAY',
          );
          expect(posted.statusCode).toBe(200);
          expect(posted.json()).toMatchObject({
            data: {
              categoryBreakdown: expect.arrayContaining([
                expect.objectContaining({
                  grossSpending: '100.000001',
                  label: 'Categoria da pessoa',
                  netSpending: '100.000001',
                  status: 'POSTED',
                }),
              ]),
              from: '2026-08-01',
              granularity: 'DAY',
              includePending: false,
              timeSeries: expect.arrayContaining([
                expect.objectContaining({
                  currency: 'BRL',
                  periodStart: '2026-08-10',
                  status: 'POSTED',
                }),
              ]),
              to: '2026-08-31',
              totals: [
                {
                  cashFlow: {
                    inflowTotal: '1000.000004',
                    netCashFlow: '649.999987',
                    outflowTotal: '350.000017',
                    transactionCount: 4,
                  },
                  currency: 'BRL',
                  spending: {
                    grossSpending: '305.000010',
                    netSpending: '285.000007',
                    refundTotal: '20.000003',
                    transactionCount: 4,
                  },
                  status: 'POSTED',
                },
              ],
            },
            freshness: {
              isStale: true,
              lastSuccessfulSyncAt: '2026-08-20T12:00:00.000Z',
              oldestAccountSyncAt: '2026-08-20T12:00:00.000Z',
              staleAfterMinutes: 1440,
            },
            meta: { policyVersion: 1, workspaceId },
            warnings: expect.arrayContaining([
              expect.objectContaining({ affectedAccountCount: 2, code: 'INCOMPLETE_HISTORY' }),
              expect.objectContaining({
                code: 'UNCONVERTED_CURRENCY',
                excludedTransactionCount: 1,
              }),
              expect.objectContaining({ affectedBillCount: 1, code: 'UNRECONCILED_BILL' }),
              expect.objectContaining({ affectedAccountCount: 2, code: 'STALE_DATA' }),
              expect.objectContaining({ affectedAccountCount: 2, code: 'CONNECTION_ATTENTION' }),
            ]),
          });
          expect(posted.body).not.toMatch(/private|1234|9876|synthetic-owner/iu);
          expect(posted.body).not.toContain('999.000000');

          const withPending = await get(
            '/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31' + '&includePending=true',
            mcpToken,
          );
          expect(withPending.statusCode).toBe(200);
          const withPendingBody = withPending.json();
          expect(withPendingBody.data.includePending).toBe(true);
          expect(
            withPendingBody.data.totals.find(
              (total: { status: string }) => total.status === 'PENDING',
            ),
          ).toMatchObject({
            cashFlow: { netCashFlow: '-10.000008' },
            spending: { netSpending: '10.000008' },
            status: 'PENDING',
          });
          expect(withPending.body).not.toMatch(/"(?:account|category|merchant|transaction)Id"/u);

          const otherCategory = await get(
            `/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31&categoryId=${otherCategoryId}`,
          );
          expect(otherCategory.statusCode).toBe(200);
          expect(otherCategory.json()).toMatchObject({ data: { totals: [] } });
          expect(
            (
              await get(
                '/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31',
                webhookToken,
              )
            ).statusCode,
          ).toBe(401);
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
