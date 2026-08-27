import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { ClassificationManagementRepository } from '@cashcount/db/finance';
import {
  createWebhookDatabasePool,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
} from '@cashcount/db/webhook';
import { describe, expect, it } from 'vitest';

import { createApiServer } from './api-server.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_classification_api_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected classification API database identifier.');
  }
  return `"${identifier}"`;
}

describe('classification management API integration', () => {
  it('isolates management, rewires audited merges, and previews rules without mutation', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_classification_api_${randomUUID().replaceAll('-', '')}`;
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
        const otherWorkspaceId = '10000000-0000-4000-8000-000000000064';
        const connectionId = '20000000-0000-4000-8000-000000000064';
        const accountId = '30000000-0000-4000-8000-000000000064';
        const globalCategoryId = '35000000-0000-4000-8000-000000000064';
        const sourceMerchantId = '40000000-0000-4000-8000-000000000064';
        const targetMerchantId = '40000000-0000-4000-8000-000000000065';
        const otherMerchantId = '40000000-0000-4000-8000-000000000066';
        const transactionId = '50000000-0000-4000-8000-000000000064';
        const installmentId = '60000000-0000-4000-8000-000000000064';
        const recurringId = '70000000-0000-4000-8000-000000000064';

        await client.query(`insert into workspace (id, name) values ($1, 'Other Workspace')`, [
          otherWorkspaceId,
        ]);
        await client.query(
          `insert into category (id, workspace_id, code, kind, name_en, name_pt_br)
           values ($1, null, 'expense.food', 'EXPENSE', 'Food', 'Alimentação')`,
          [globalCategoryId],
        );
        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, $2, 'PLUGGY', 'classification-private-item', 'synthetic',
                     'Synthetic Classification Bank')`,
          [connectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency, masked_number
           ) values ($1, $2, $3, 'PLUGGY', 'classification-private-account',
                     'CHECKING', 'Synthetic Checking', 'Synthetic Bank', 'BRL', '1234')`,
          [accountId, workspaceId, connectionId],
        );
        await client.query(
          `insert into merchant (
             id, workspace_id, canonical_name, normalized_key, cnpj_hash, review_status
           ) values
             ($1, $4, 'Source Market', 'source market', repeat('a', 64), 'NEEDS_REVIEW'),
             ($2, $4, 'Target Market', 'target market', null, 'CONFIRMED'),
             ($3, $5, 'Other Market', 'other market', null, 'CONFIRMED')`,
          [sourceMerchantId, targetMerchantId, otherMerchantId, workspaceId, otherWorkspaceId],
        );
        await client.query(
          `insert into merchant_alias (
             workspace_id, merchant_id, alias_normalized, match_type, source, confidence,
             is_active, is_confirmed
           ) values ($1, $2, 'source alias', 'EXACT', 'USER', 1, true, true)`,
          [workspaceId, sourceMerchantId],
        );
        await client.query(
          `insert into installment_series (
             id, workspace_id, financial_account_id, merchant_id, currency, total_installments
           ) values ($1, $2, $3, $4, 'BRL', 2)`,
          [installmentId, workspaceId, accountId, sourceMerchantId],
        );
        await client.query(
          `insert into recurring_series (
             id, workspace_id, merchant_id, cadence, expected_interval_days, currency,
             amount_min, amount_max, amount_average, last_occurrence_date, confidence
           ) values ($1, $2, $3, 'MONTHLY', 30, 'BRL', 10, 10, 10, '2026-08-26', 1)`,
          [recurringId, workspaceId, sourceMerchantId],
        );
        await client.query(
          `insert into financial_transaction (
             id, workspace_id, financial_account_id, provider, provider_transaction_id, status,
             provider_type, provider_amount_signed, provider_currency,
             account_currency_amount_signed, account_currency, system_direction,
             system_financial_role, provider_transaction_at, transaction_local_date,
             description_original, description_normalized, system_merchant_id,
             system_merchant_source, installment_series_id, recurring_series_id,
             dedupe_fingerprint
           ) values (
             $1, $2, $3, 'PLUGGY', 'classification-private-transaction', 'POSTED', 'DEBIT',
             -42.123456, 'BRL', -42.123456, 'BRL', 'OUTFLOW', 'PURCHASE',
             '2026-08-26T12:00:00Z', '2026-08-26',
             'PIX CPF 123.456.789-09 card 4111111111111111 Source Market',
             'pix cpf 123.456.789-09 card 4111111111111111 source market', $4,
             'MERCHANT', $5, $6, repeat('b', 64)
           )`,
          [transactionId, workspaceId, accountId, sourceMerchantId, installmentId, recurringId],
        );
        await client.query(
          `insert into transaction_user_state (
             financial_transaction_id, workspace_id, merchant_override_enabled,
             merchant_id_override, updated_by_actor_type, updated_by_actor_id
           ) values ($1, $2, true, $3, 'USER', 'synthetic-owner')`,
          [transactionId, workspaceId, sourceMerchantId],
        );
        await client.query(
          `insert into classification_decision (
             workspace_id, financial_transaction_id, source, source_reference, merchant_id,
             confidence, input_fingerprint, rationale, selected
           ) values ($1, $2, 'MERCHANT', $3::text, $3::uuid, 1, repeat('c', 64),
                     'Synthetic merchant decision', true)`,
          [workspaceId, transactionId, sourceMerchantId],
        );

        const webToken = 'synthetic-web-token-classification-boundary-00000000001';
        const mcpToken = 'synthetic-mcp-token-classification-boundary-00000000001';
        const server = createApiServer({
          classificationManagement: {
            actorId: 'service_web',
            repository: new ClassificationManagementRepository(client),
            webToken,
            workspaceId,
          },
          inbox: {
            ingestAuthenticatedPluggyWebhook: async () => {
              throw new Error('Webhook must not be invoked by classification management.');
            },
          },
          mcpToken,
          nodeEnvironment: 'test',
          webhookSecret: 'synthetic-webhook-token-classification-boundary-000001',
          workspaceId,
        });
        try {
          const call = (
            method: 'DELETE' | 'GET' | 'PATCH' | 'POST',
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

          const categories = await call('GET', '/v1/categories?limit=100');
          expect(categories.statusCode).toBe(200);
          const builtIn = (
            categories.json() as { data: { items: { id: string; scope: string }[] } }
          ).data.items.find(({ scope }) => scope === 'BUILT_IN');
          expect(builtIn).toBeDefined();
          expect(
            (await call('PATCH', `/v1/categories/${builtIn?.id}`, { nameEn: 'Mutated' }))
              .statusCode,
          ).toBe(404);

          const createdCategory = await call('POST', '/v1/categories', {
            kind: 'EXPENSE',
            nameEn: 'Markets',
            namePtBr: 'Mercados',
            parentId: builtIn?.id,
            sortOrder: 12,
          });
          expect(createdCategory.statusCode).toBe(201);
          const categoryId = (createdCategory.json() as { data: { id: string } }).data.id;
          expect(
            (
              await call('PATCH', `/v1/categories/${categoryId}`, {
                iconKey: 'basket',
                namePtBr: 'Supermercados',
              })
            ).json(),
          ).toMatchObject({ data: { iconKey: 'basket', namePtBr: 'Supermercados' } });

          expect((await call('GET', `/v1/merchants/${otherMerchantId}`)).statusCode).toBe(404);
          expect((await call('GET', '/v1/merchants', undefined, mcpToken)).statusCode).toBe(401);
          const patchedMerchant = await call('PATCH', `/v1/merchants/${targetMerchantId}`, {
            defaultCategoryId: categoryId,
            mcc: '5411',
            merchantGroup: 'Groceries',
          });
          expect(patchedMerchant.statusCode).toBe(200);
          expect(patchedMerchant.body).not.toMatch(/cnpj|private|normalizedKey/iu);

          const conditions = {
            root: {
              field: 'merchant.id',
              operator: 'eq',
              type: 'PREDICATE',
              value: sourceMerchantId,
            },
            version: '1',
          };
          const actions = {
            operations: [{ merchantId: sourceMerchantId, type: 'SET_MERCHANT' }],
            version: '1',
          };
          const createdRule = await call('POST', '/v1/classification-rules', {
            actions,
            conditions,
            name: 'Source merchant rule',
            priority: 100,
            stopProcessing: true,
          });
          expect(createdRule.statusCode).toBe(201);
          const ruleId = (createdRule.json() as { data: { id: string } }).data.id;

          const countsBefore = await client.query<{ decisions: string; hits: string }>(
            `select
               (select count(*)::text from classification_decision where workspace_id = $1) decisions,
               (select hit_count::text from classification_rule where workspace_id = $1 and id = $2) hits`,
            [workspaceId, ruleId],
          );
          const preview = await call('POST', `/v1/classification-rules/${ruleId}/test`, {
            from: '2026-08-01',
            limit: 10,
            to: '2026-08-31',
          });
          expect(preview.statusCode).toBe(200);
          expect(preview.json()).toMatchObject({
            data: { matches: [{ transactionId, wouldStopProcessing: true }], scannedCount: 1 },
          });
          expect(preview.body).not.toMatch(/123\.456\.789-09|4111111111111111/u);
          expect(preview.body).toContain('••••1111');
          const countsAfter = await client.query<{ decisions: string; hits: string }>(
            `select
               (select count(*)::text from classification_decision where workspace_id = $1) decisions,
               (select hit_count::text from classification_rule where workspace_id = $1 and id = $2) hits`,
            [workspaceId, ruleId],
          );
          expect(countsAfter.rows[0]).toEqual(countsBefore.rows[0]);

          const merged = await call('POST', '/v1/merchants/merge', {
            sourceMerchantId,
            targetMerchantId,
          });
          expect(merged.statusCode).toBe(200);
          expect(merged.json()).toMatchObject({
            data: {
              aliases: expect.arrayContaining([
                expect.objectContaining({ alias: 'source market', isConfirmed: true }),
                expect.objectContaining({ alias: 'source alias', isConfirmed: true }),
              ]),
              id: targetMerchantId,
            },
          });
          const rewired = await client.query<{
            actions: { operations: { merchantId: string }[] };
            audit_count: string;
            cnpj_hash: string;
            conditions: { root: { value: string } };
            decision_merchant_id: string;
            installment_merchant_id: string;
            recurring_merchant_id: string;
            source_count: string;
            state_merchant_id: string;
            system_merchant_id: string;
            version: number;
          }>(
            `select
               ft.system_merchant_id, tus.merchant_id_override as state_merchant_id, tus.version,
               cd.merchant_id as decision_merchant_id,
               ins.merchant_id as installment_merchant_id,
               rec.merchant_id as recurring_merchant_id,
               rule.conditions, rule.actions, merchant.cnpj_hash,
               (select count(*)::text from merchant where workspace_id = $1 and id = $3) source_count,
               (select count(*)::text from audit_event
                where workspace_id = $1 and event_type = 'MERCHANT_MERGED'
                  and target_id = $4::text) audit_count
             from financial_transaction ft
             join transaction_user_state tus on tus.financial_transaction_id = ft.id
             join classification_decision cd on cd.financial_transaction_id = ft.id
             join installment_series ins on ins.id = ft.installment_series_id
             join recurring_series rec on rec.id = ft.recurring_series_id
             join classification_rule rule on rule.workspace_id = ft.workspace_id and rule.id = $2
             join merchant on merchant.workspace_id = ft.workspace_id and merchant.id = $4
             where ft.workspace_id = $1 and ft.id = $5`,
            [workspaceId, ruleId, sourceMerchantId, targetMerchantId, transactionId],
          );
          expect(rewired.rows[0]).toMatchObject({
            actions: { operations: [{ merchantId: targetMerchantId }] },
            audit_count: '1',
            cnpj_hash: 'a'.repeat(64),
            conditions: { root: { value: targetMerchantId } },
            decision_merchant_id: targetMerchantId,
            installment_merchant_id: targetMerchantId,
            recurring_merchant_id: targetMerchantId,
            source_count: '0',
            state_merchant_id: targetMerchantId,
            system_merchant_id: targetMerchantId,
            version: 2,
          });

          const previewAfterMerge = await call('POST', `/v1/classification-rules/${ruleId}/test`, {
            from: '2026-08-01',
            to: '2026-08-31',
          });
          expect(previewAfterMerge.json()).toMatchObject({
            data: { matches: [{ transactionId }] },
          });

          const deactivated = await call('DELETE', `/v1/classification-rules/${ruleId}`);
          expect(deactivated.statusCode).toBe(204);
          expect(
            await client.query<{ count: string; is_active: boolean }>(
              `select count(*)::text, bool_and(is_active) is_active
               from classification_rule where workspace_id = $1 and id = $2`,
              [workspaceId, ruleId],
            ),
          ).toMatchObject({ rows: [{ count: '1', is_active: false }] });
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
