import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  ClassificationRuleInvariantError,
  ClassificationRuleRepository,
  ClassificationTransactionNotFoundError,
} from './classification-rule-repository.js';
import { runMigrations } from './migrations.js';
import { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_rules_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected rule test database identifier.');
  }
  return `"${identifier}"`;
}

function conditions(value = 'casa do pão'): Record<string, unknown> {
  return {
    version: '1',
    root: {
      type: 'PREDICATE',
      field: 'transaction.descriptionNormalized',
      operator: 'contains',
      value,
    },
  };
}

function actions(...operations: Record<string, unknown>[]): Record<string, unknown> {
  return { version: '1', operations };
}

describe('PostgreSQL classification rule repository', () => {
  it('applies ordered rules with conflicts and fingerprint-idempotent hits by workspace', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_rules_${randomUUID().replaceAll('-', '')}`;
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${databaseName}`;
    const admin = new Pool({ connectionString: databaseUrl });

    try {
      await admin.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(testUrl.toString());
      await seedSyntheticIdentity(testUrl.toString(), 'test');
      const pool = new Pool({ connectionString: testUrl.toString() });
      pool.on('error', () => undefined);

      try {
        const repository = new ClassificationRuleRepository(pool);
        const workspaceA = syntheticIdentitySeed.workspace.id;
        const workspaceB = '20000000-0000-4000-8000-000000000053';
        const connectionA = '30000000-0000-4000-8000-000000000053';
        const connectionB = '30000000-0000-4000-8000-000000000054';
        const accountA = '40000000-0000-4000-8000-000000000053';
        const accountB = '40000000-0000-4000-8000-000000000054';
        const transactionA = '50000000-0000-4000-8000-000000000053';
        const transactionB = '50000000-0000-4000-8000-000000000054';
        const categoryA = '60000000-0000-4000-8000-000000000053';
        const categoryAlternative = '60000000-0000-4000-8000-000000000054';
        const categoryB = '60000000-0000-4000-8000-000000000055';
        const merchantA = '70000000-0000-4000-8000-000000000053';
        const merchantB = '70000000-0000-4000-8000-000000000054';
        const tagA = '80000000-0000-4000-8000-000000000053';
        const tagB = '80000000-0000-4000-8000-000000000054';

        await pool.query(`insert into workspace (id, name) values ($1, 'Rule Workspace B')`, [
          workspaceB,
        ]);
        await pool.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values
             ($1, $3, 'PLUGGY', 'rule-connection-a', 'connector-a', 'Rule Bank A'),
             ($2, $4, 'PLUGGY', 'rule-connection-b', 'connector-b', 'Rule Bank B')`,
          [connectionA, connectionB, workspaceA, workspaceB],
        );
        await pool.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency
           ) values
             ($1, $3, $5, 'PLUGGY', 'rule-account-a', 'CREDIT_CARD', 'Card A', 'Rule Bank A', 'BRL'),
             ($2, $4, $6, 'PLUGGY', 'rule-account-b', 'CHECKING', 'Account B', 'Rule Bank B', 'BRL')`,
          [accountA, accountB, workspaceA, workspaceB, connectionA, connectionB],
        );
        for (const [categoryId, workspaceId] of [
          [categoryA, workspaceA],
          [categoryAlternative, workspaceA],
          [categoryB, workspaceB],
        ]) {
          await pool.query(
            `insert into category (id, workspace_id, code, kind, name_en, name_pt_br)
             values ($1, $2, $3, 'EXPENSE', 'Synthetic', 'Sintética')`,
            [categoryId, workspaceId, `custom.${categoryId}`],
          );
        }
        await pool.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key, review_status)
           values ($1, $3, 'Casa do Pão', 'casa do pao', 'CONFIRMED'),
                  ($2, $4, 'Other Workspace Merchant', 'other merchant', 'CONFIRMED')`,
          [merchantA, merchantB, workspaceA, workspaceB],
        );
        await pool.query(
          `insert into tag (id, workspace_id, name, normalized_name)
           values ($1, $3, 'Bakery', 'bakery'), ($2, $4, 'Other', 'other')`,
          [tagA, tagB, workspaceA, workspaceB],
        );
        await pool.query(
          `insert into financial_transaction (
             id, workspace_id, financial_account_id, provider, provider_transaction_id,
             status, provider_type, provider_amount_signed, provider_currency,
             account_currency_amount_signed, account_currency, provider_transaction_at,
             transaction_local_date, description_original, description_normalized, dedupe_fingerprint
           ) values
             ($1, $3, $5, 'PLUGGY', 'rule-tx-a', 'POSTED', 'DEBIT', '-25.500000', 'BRL',
              '-25.500000', 'BRL', '2026-08-24T12:00:00Z', '2026-08-24',
              'CASA DO PÃO', 'casa do pão', $7),
             ($2, $4, $6, 'PLUGGY', 'rule-tx-b', 'POSTED', 'DEBIT', '-10.000000', 'BRL',
              '-10.000000', 'BRL', '2026-08-24T12:00:00Z', '2026-08-24',
              'CASA DO PÃO', 'casa do pão', $8)`,
          [
            transactionA,
            transactionB,
            workspaceA,
            workspaceB,
            accountA,
            accountB,
            'a'.repeat(64),
            'b'.repeat(64),
          ],
        );

        const high = await repository.createRule(workspaceA, {
          actorId: 'owner-a',
          name: 'Bakery category',
          priority: 100,
          conditions: conditions(),
          actions: actions(
            { type: 'SET_CATEGORY', categoryId: categoryA },
            { type: 'ADD_TAG', tagId: tagA },
          ),
          source: 'USER',
          stopProcessing: false,
        });
        const lower = await repository.createRule(workspaceA, {
          actorId: 'owner-a',
          name: 'Purchase details',
          priority: 50,
          conditions: conditions(),
          actions: actions(
            { type: 'SET_CATEGORY', categoryId: categoryAlternative },
            { type: 'SET_MERCHANT', merchantId: merchantA },
            { type: 'SET_FINANCIAL_ROLE', financialRole: 'PURCHASE' },
            { type: 'SET_SPEND_INCLUSION', inclusion: 'EXCLUDE' },
            { type: 'MARK_RECURRING_CANDIDATE' },
          ),
          source: 'USER',
          stopProcessing: false,
        });
        const tagConflict = await repository.createRule(workspaceA, {
          actorId: 'owner-a',
          name: 'Contradictory tag',
          priority: 10,
          conditions: conditions(),
          actions: actions({ type: 'REMOVE_TAG', tagId: tagA }, { type: 'STOP_PROCESSING' }),
          source: 'IMPORT',
          stopProcessing: false,
        });
        const suggestion = await repository.createRule(workspaceA, {
          actorId: 'owner-a',
          name: 'Unconfirmed suggestion',
          priority: 1_000,
          conditions: conditions(),
          actions: actions({ type: 'SET_CATEGORY', categoryId: categoryAlternative }),
          source: 'SYSTEM_SUGGESTION',
        });
        expect(suggestion.isActive).toBe(false);

        for (const [name, crossActions] of [
          ['Cross category', actions({ type: 'SET_CATEGORY', categoryId: categoryB })],
          ['Cross merchant', actions({ type: 'SET_MERCHANT', merchantId: merchantB })],
          ['Cross tag', actions({ type: 'ADD_TAG', tagId: tagB })],
        ] as const) {
          await expect(
            repository.createRule(workspaceA, {
              actorId: 'owner-a',
              name,
              priority: 1,
              conditions: conditions(),
              actions: crossActions,
              source: 'USER',
            }),
          ).rejects.toBeInstanceOf(ClassificationRuleInvariantError);
        }
        await expect(
          pool.query(
            `insert into classification_rule (
               workspace_id, name, priority, conditions, actions, source
             ) values ($1, 'SQL bypass', 1, $2::jsonb, $3::jsonb, 'USER')`,
            [
              workspaceA,
              JSON.stringify(conditions()),
              JSON.stringify(actions({ type: 'SET_CATEGORY', categoryId: categoryB })),
            ],
          ),
        ).rejects.toThrow(/not visible/u);

        const concurrent = await Promise.all([
          repository.evaluateTransaction(workspaceA, transactionA),
          repository.evaluateTransaction(workspaceA, transactionA),
        ]);
        expect(concurrent.map(({ newlyRecordedMatches }) => newlyRecordedMatches).sort()).toEqual([
          0, 3,
        ]);
        expect(new Set(concurrent.map(({ inputFingerprint }) => inputFingerprint)).size).toBe(1);
        const result = concurrent[0];
        expect(result?.evaluation.matchedRules.map(({ ruleId }) => ruleId)).toEqual([
          high.id,
          lower.id,
          tagConflict.id,
        ]);
        expect(result?.evaluation.actions.category).toEqual({ ruleId: high.id, value: categoryA });
        expect(result?.evaluation.actions.recurringCandidate).toEqual({
          ruleId: lower.id,
          value: true,
        });
        expect(result?.evaluation.conflicts).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: 'categoryId',
              winningRuleId: high.id,
              losingRuleId: lower.id,
            }),
            expect.objectContaining({
              field: `tag:${tagA}`,
              winningRuleId: high.id,
              losingRuleId: tagConflict.id,
            }),
          ]),
        );

        expect(
          await pool.query(
            `select system_category_id, system_merchant_id, system_financial_role,
                    system_is_excluded_from_spend
             from financial_transaction where workspace_id = $1 and id = $2`,
            [workspaceA, transactionA],
          ),
        ).toMatchObject({
          rows: [
            {
              system_category_id: categoryA,
              system_merchant_id: merchantA,
              system_financial_role: 'PURCHASE',
              system_is_excluded_from_spend: true,
            },
          ],
        });
        expect(
          await pool.query<{ count: number }>(
            `select count(*)::integer as count from transaction_tag
             where workspace_id = $1 and financial_transaction_id = $2 and tag_id = $3`,
            [workspaceA, transactionA, tagA],
          ),
        ).toMatchObject({ rows: [{ count: 1 }] });
        expect(
          await pool.query<{ hit_count: string }>(
            `select hit_count::text from classification_rule
             where workspace_id = $1 and id = any($2::uuid[]) order by priority desc`,
            [workspaceA, [high.id, lower.id, tagConflict.id]],
          ),
        ).toMatchObject({ rows: [{ hit_count: '1' }, { hit_count: '1' }, { hit_count: '1' }] });
        expect(
          await pool.query<{ count: number }>(
            `select count(*)::integer as count from classification_decision
             where workspace_id = $1 and financial_transaction_id = $2`,
            [workspaceA, transactionA],
          ),
        ).toMatchObject({ rows: [{ count: 3 }] });

        const retry = await repository.evaluateTransaction(workspaceA, transactionA);
        expect(retry.newlyRecordedMatches).toBe(0);
        expect(retry.inputFingerprint).toBe(result?.inputFingerprint);
        await expect(
          repository.evaluateTransaction(workspaceA, transactionB),
        ).rejects.toBeInstanceOf(ClassificationTransactionNotFoundError);

        await pool.query(
          `insert into classification_rule (
             workspace_id, name, priority, conditions, actions, source
           ) values ($1, 'Invalid stored DSL', 2000,
                     '{"version":"1","root":{"type":"PREDICATE","field":"transaction.rawPayload","operator":"eq","value":"unsafe"}}'::jsonb,
                     '{"version":"1","operations":[{"type":"STOP_PROCESSING"}]}'::jsonb,
                     'USER')`,
          [workspaceA],
        );
        await expect(repository.evaluateTransaction(workspaceA, transactionA)).rejects.toThrow();
        expect(
          await pool.query<{ count: number }>(
            `select count(*)::integer as count from audit_event
             where workspace_id = $1 and event_type = 'CLASSIFICATION_RULE_CREATED'`,
            [workspaceA],
          ),
        ).toMatchObject({ rows: [{ count: 4 }] });
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)} with (force)`);
      await admin.end();
    }
  }, 30_000);
});
