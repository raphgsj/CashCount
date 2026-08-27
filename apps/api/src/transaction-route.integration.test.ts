import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { TransactionApiRepository } from '@cashcount/db/finance';
import {
  createWebhookDatabasePool,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
} from '@cashcount/db/webhook';
import { describe, expect, it } from 'vitest';

import { createApiServer } from './api-server.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_transaction_api_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected transaction API database identifier.');
  }
  return `"${identifier}"`;
}

describe('transaction API integration', () => {
  it('reads effective evidence and atomically applies isolated optimistic corrections', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_transaction_api_${randomUUID().replaceAll('-', '')}`;
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
        const otherWorkspaceId = '10000000-0000-4000-8000-000000000063';
        const connectionId = '20000000-0000-4000-8000-000000000063';
        const otherConnectionId = '20000000-0000-4000-8000-000000000064';
        const checkingId = '30000000-0000-4000-8000-000000000063';
        const cardId = '30000000-0000-4000-8000-000000000064';
        const otherAccountId = '30000000-0000-4000-8000-000000000065';
        const categoryId = '40000000-0000-4000-8000-000000000063';
        const otherCategoryId = '40000000-0000-4000-8000-000000000064';
        const merchantId = '50000000-0000-4000-8000-000000000063';
        const otherMerchantId = '50000000-0000-4000-8000-000000000064';
        const tagId = '60000000-0000-4000-8000-000000000063';
        const billId = '70000000-0000-4000-8000-000000000063';
        const checkingTransactionId = '80000000-0000-4000-8000-000000000063';
        const olderTransactionId = '80000000-0000-4000-8000-000000000064';
        const cardTransactionId = '80000000-0000-4000-8000-000000000065';
        const replacementId = '80000000-0000-4000-8000-000000000066';
        const otherTransactionId = '80000000-0000-4000-8000-000000000067';

        await client.query(`insert into workspace (id, name) values ($1, 'Other API Workspace')`, [
          otherWorkspaceId,
        ]);
        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id,
             display_name, local_status, last_successful_sync_at
           ) values
             ($1, $3, 'PLUGGY', 'transaction-api-private-item', 'synthetic',
              'Synthetic API Bank', 'ACTIVE', now()),
             ($2, $4, 'PLUGGY', 'other-transaction-api-private-item', 'synthetic',
              'Other API Bank', 'ACTIVE', now())`,
          [connectionId, otherConnectionId, workspaceId, otherWorkspaceId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id, account_type,
             name, institution_name, currency, masked_number, last_successful_sync_at,
             provider_history_earliest_date, provider_history_latest_date, history_coverage_status
           ) values
             ($1, $4, $6, 'PLUGGY', 'checking-private-id', 'CHECKING', 'Synthetic Checking',
              'Synthetic API Bank', 'BRL', '1234', now(), '2026-08-10', '2026-08-26', 'PARTIAL'),
             ($2, $4, $6, 'PLUGGY', 'card-private-id', 'CREDIT_CARD', 'Synthetic Card',
              'Synthetic API Bank', 'BRL', '9876', now(), '2026-08-01', '2026-08-26',
              'PROVIDER_MAXIMUM_RETRIEVED'),
             ($3, $5, $7, 'PLUGGY', 'other-account-private-id', 'CHECKING', 'Other Checking',
              'Other API Bank', 'BRL', '1111', now(), null, null, 'UNKNOWN')`,
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
          `insert into category (
             id, workspace_id, code, kind, name_en, name_pt_br
           ) values
             ($1, $3, 'custom.40000000-0000-4000-8000-000000000063', 'EXPENSE',
              'Purchases', 'Compras'),
             ($2, $4, 'custom.40000000-0000-4000-8000-000000000064', 'EXPENSE',
              'Other', 'Outra')`,
          [categoryId, otherCategoryId, workspaceId, otherWorkspaceId],
        );
        await client.query(
          `insert into merchant (
             id, workspace_id, canonical_name, normalized_key, review_status
           ) values
             ($1, $3, 'Synthetic Market', 'synthetic market', 'CONFIRMED'),
             ($2, $4, 'Other Market', 'other market', 'CONFIRMED')`,
          [merchantId, otherMerchantId, workspaceId, otherWorkspaceId],
        );
        await client.query(
          `insert into tag (id, workspace_id, name, normalized_name)
           values ($1, $2, 'Reviewed', 'reviewed')`,
          [tagId, workspaceId],
        );
        await client.query(
          `insert into credit_card_bill (
             id, workspace_id, financial_account_id, provider, external_bill_id, status,
             due_date, close_date, total_amount, currency
           ) values ($1, $2, $3, 'PLUGGY', 'bill-private-id', 'OPEN', '2026-08-30',
                     '2026-08-20', 50.123456, 'BRL')`,
          [billId, workspaceId, cardId],
        );

        const insertTransaction = async (input: {
          accountId: string;
          accountAmount?: string;
          accountCurrency?: string;
          billId?: string;
          categoryId?: string;
          date: string;
          description: string;
          id: string;
          merchantId?: string;
          originalAmount: string;
          originalCurrency?: string;
          providerId: string;
          workspaceId: string;
        }) =>
          client.query(
            `insert into financial_transaction (
               id, workspace_id, financial_account_id, provider, provider_transaction_id, status,
               provider_amount_signed, provider_currency, account_currency_amount_signed,
               account_currency, system_direction, system_financial_role,
               system_is_excluded_from_spend, provider_transaction_at, transaction_local_date,
               description_original, description_normalized, system_category_id,
               system_category_source, system_merchant_id, system_merchant_source,
               system_financial_role_source, system_exclusion_source, credit_card_bill_id,
               installment_number, installment_total, installment_total_amount, card_last_four,
               bill_forecast_month, duplicate_review_status, dedupe_fingerprint
             ) values (
               $1, $2, $3, 'PLUGGY', $4, 'POSTED', $5, $6, $7, $8, 'OUTFLOW', 'PURCHASE',
               false, ($9::date + time '12:00') at time zone 'UTC', $9, $10, lower($10), $11,
               case when $11::uuid is null then 'NONE' else 'RULE' end, $12,
               case when $12::uuid is null then 'NONE' else 'MERCHANT' end, 'HEURISTIC', 'POLICY',
               $13, case when $13::uuid is null then null else 1 end,
               case when $13::uuid is null then null else 2 end,
               case when $13::uuid is null then null else 100.246912 end,
               case when $13::uuid is null then null else '9876' end,
               case when $13::uuid is null then null else '2026-08-01'::date end,
               'NONE', repeat(md5($4), 2)
             )`,
            [
              input.id,
              input.workspaceId,
              input.accountId,
              input.providerId,
              input.originalAmount,
              input.originalCurrency ?? 'BRL',
              input.accountAmount ?? input.originalAmount,
              input.accountCurrency ?? 'BRL',
              input.date,
              input.description,
              input.categoryId ?? null,
              input.merchantId ?? null,
              input.billId ?? null,
            ],
          );

        await insertTransaction({
          accountId: checkingId,
          categoryId,
          date: '2026-08-26',
          description: 'Newest synthetic purchase CPF 123.456.789-09 card 4111111111111111',
          id: checkingTransactionId,
          merchantId,
          originalAmount: '-10.100001',
          providerId: 'newest-private-provider-id',
          workspaceId,
        });
        await insertTransaction({
          accountId: checkingId,
          categoryId,
          date: '2026-08-25',
          description: 'Older synthetic purchase',
          id: olderTransactionId,
          originalAmount: '-20.200002',
          providerId: 'older-private-provider-id',
          workspaceId,
        });
        await insertTransaction({
          accountCurrency: 'BRL',
          accountId: cardId,
          billId,
          date: '2026-08-24',
          description: 'Card purchase in USD',
          id: cardTransactionId,
          originalAmount: '50.123456',
          originalCurrency: 'USD',
          providerId: 'card-private-provider-id',
          workspaceId,
        });
        await client.query(
          `update financial_transaction set account_currency_amount_signed = null where id = $1`,
          [cardTransactionId],
        );
        await insertTransaction({
          accountId: cardId,
          billId,
          date: '2026-08-23',
          description: 'Replacement candidate',
          id: replacementId,
          originalAmount: '50.123456',
          providerId: 'replacement-private-provider-id',
          workspaceId,
        });
        await insertTransaction({
          accountId: otherAccountId,
          date: '2026-08-26',
          description: 'Other private transaction',
          id: otherTransactionId,
          originalAmount: '-1.000001',
          providerId: 'other-private-provider-id',
          workspaceId: otherWorkspaceId,
        });
        await client.query(
          `insert into transaction_identity_link (
             workspace_id, predecessor_transaction_id, successor_transaction_id, status,
             confidence, evidence
           ) values ($1, $2, $3, 'NEEDS_REVIEW', 0.9000, '{"synthetic":true}')`,
          [workspaceId, cardTransactionId, replacementId],
        );

        const webToken = 'synthetic-web-token-transaction-boundary-0000000000001';
        const mcpToken = 'synthetic-mcp-token-transaction-boundary-0000000000001';
        const server = createApiServer({
          inbox: {
            ingestAuthenticatedPluggyWebhook: async () => {
              throw new Error('Webhook must not be invoked by transaction routes.');
            },
          },
          mcpToken,
          nodeEnvironment: 'test',
          transactions: {
            actorId: 'service_web',
            repository: new TransactionApiRepository(client),
            webToken,
            workspaceId,
          },
          webhookSecret: 'synthetic-webhook-token-transaction-boundary-000001',
          workspaceId,
        });
        try {
          const call = (
            method: 'GET' | 'PATCH',
            path: string,
            payload?: Record<string, unknown>,
            token = webToken,
          ) =>
            server.inject({
              headers: { authorization: `Bearer ${token}` },
              method,
              ...(payload === undefined ? {} : { payload }),
              url: path,
            });

          const list = await call('GET', '/v1/transactions?from=2026-08-01&to=2026-08-31&limit=2');
          expect(list.statusCode).toBe(200);
          expect(list.json()).toMatchObject({
            data: {
              items: [
                { id: checkingTransactionId, originalAmount: { value: '-10.100001' } },
                { id: olderTransactionId, originalAmount: { value: '-20.200002' } },
              ],
              page: { limit: 2, nextCursor: expect.any(String) },
            },
            meta: { warnings: [{ code: 'INCOMPLETE_HISTORY' }], workspaceId },
          });
          expect(list.body).not.toMatch(/123\.456\.789-09|4111111111111111/u);

          const card = await call('GET', `/v1/transactions/${cardTransactionId}`);
          expect(card.statusCode).toBe(200);
          expect(card.json()).toMatchObject({
            data: {
              accountCurrencyAmount: null,
              analyticsAmount: null,
              bill: { id: billId, status: 'OPEN' },
              card: { installmentNumber: 1, installmentTotal: 2, lastFour: '9876' },
              replacementContext: [
                {
                  confidence: '0.9000',
                  relatedTransactionId: replacementId,
                  relationship: 'PREDECESSOR',
                  status: 'NEEDS_REVIEW',
                },
              ],
              warnings: [{ code: 'UNCONVERTED_CURRENCY' }],
            },
          });
          expect(card.body).not.toMatch(
            /private-provider-id|private-id|"(?:external|provider|raw)[^"]*"\s*:/iu,
          );
          expect((await call('GET', `/v1/transactions/${otherTransactionId}`)).statusCode).toBe(
            404,
          );
          expect(
            (await call('GET', `/v1/transactions/${checkingTransactionId}`, undefined, mcpToken))
              .statusCode,
          ).toBe(401);

          const invalidReference = await call(
            'PATCH',
            `/v1/transactions/${checkingTransactionId}`,
            {
              expectedVersion: 0,
              merchantOverride: { merchantId: otherMerchantId, mode: 'SET' },
            },
          );
          expect(invalidReference.statusCode).toBe(400);
          expect(invalidReference.json()).toMatchObject({
            code: 'INVALID_REFERENCE',
            field: 'merchant',
          });

          const patch = await call('PATCH', `/v1/transactions/${checkingTransactionId}`, {
            categoryOverride: { mode: 'CLEAR' },
            excludedFromSpendOverride: { mode: 'SET', value: true },
            expectedVersion: 0,
            financialRoleOverride: { mode: 'SET', value: 'FEE' },
            merchantOverride: { merchantId, mode: 'SET' },
            notes: 'Reviewed synthetic transaction',
            reviewStatus: 'CONFIRMED',
            tagIds: [tagId],
          });
          expect(patch.statusCode).toBe(200);
          expect(patch.json()).toMatchObject({
            data: {
              effective: {
                category: { override: { mode: 'CLEAR' }, value: null },
                excludedFromSpend: { override: { mode: 'SET', value: true }, value: true },
                financialRole: { override: { mode: 'SET', value: 'FEE' }, value: 'FEE' },
                merchant: { override: { id: merchantId, mode: 'SET' } },
              },
              notes: 'Reviewed synthetic transaction',
              reviewStatus: 'CONFIRMED',
              tags: [{ id: tagId, name: 'Reviewed' }],
              userStateVersion: 1,
            },
          });
          const stale = await call('PATCH', `/v1/transactions/${checkingTransactionId}`, {
            expectedVersion: 0,
            notes: 'Stale write',
          });
          expect(stale.statusCode).toBe(409);
          expect(stale.json()).toMatchObject({ actualVersion: 1, code: 'VERSION_CONFLICT' });

          const persisted = await client.query<{
            audit_count: string;
            tag_count: string;
            version: number;
          }>(
            `select tus.version,
                    (select count(*) from transaction_tag tt
                     where tt.workspace_id = tus.workspace_id
                       and tt.financial_transaction_id = tus.financial_transaction_id) as tag_count,
                    (select count(*) from audit_event ae
                     where ae.workspace_id = tus.workspace_id
                       and ae.target_id = tus.financial_transaction_id::text
                       and ae.event_type = 'MANUAL_CORRECTION_APPLIED') as audit_count
             from transaction_user_state tus
             where tus.workspace_id = $1 and tus.financial_transaction_id = $2`,
            [workspaceId, checkingTransactionId],
          );
          expect(persisted.rows[0]).toEqual({ audit_count: '1', tag_count: '1', version: 1 });
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
