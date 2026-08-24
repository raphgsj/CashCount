import { createHash, randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { parseBankDate } from '@cashcount/domain';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  classificationQualitySources,
  ClassificationQualityRepository,
} from './classification-quality-repository.js';
import { runMigrations } from './migrations.js';
import { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_quality_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected quality test database identifier.');
  }
  return `"${identifier}"`;
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('PostgreSQL classification quality repository', () => {
  it('reports exact effective-source distribution and a stable workspace-scoped unclassified queue', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_quality_${randomUUID().replaceAll('-', '')}`;
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
        const repository = new ClassificationQualityRepository(pool);
        const workspaceA = syntheticIdentitySeed.workspace.id;
        const workspaceB = '20000000-0000-4000-8000-000000000056';
        const connectionA = '30000000-0000-4000-8000-000000000056';
        const connectionB = '30000000-0000-4000-8000-000000000057';
        const accountA = '40000000-0000-4000-8000-000000000060';
        const accountB = '40000000-0000-4000-8000-000000000061';
        const categoryA = '50000000-0000-4000-8000-000000000056';
        const categoryUser = '50000000-0000-4000-8000-000000000057';
        const categoryB = '50000000-0000-4000-8000-000000000058';
        const merchantA = '60000000-0000-4000-8000-000000000069';
        const ruleTransaction = '70000000-0000-4000-8000-000000000069';
        const merchantTransaction = '70000000-0000-4000-8000-000000000070';
        const userTransaction = '70000000-0000-4000-8000-000000000071';
        const missingTransaction = '70000000-0000-4000-8000-000000000072';
        const explicitlyClearedTransaction = '70000000-0000-4000-8000-000000000073';
        const deletedTransaction = '70000000-0000-4000-8000-000000000074';
        const otherWorkspaceTransaction = '70000000-0000-4000-8000-000000000075';

        await pool.query(`insert into workspace (id, name) values ($1, 'Quality Workspace B')`, [
          workspaceB,
        ]);
        await pool.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values
             ($1, $3, 'PLUGGY', 'quality-connection-a', 'connector-a', 'Quality Bank A'),
             ($2, $4, 'PLUGGY', 'quality-connection-b', 'connector-b', 'Quality Bank B')`,
          [connectionA, connectionB, workspaceA, workspaceB],
        );
        await pool.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency
           ) values
             ($1, $3, $5, 'PLUGGY', 'quality-account-a', 'CHECKING',
              'Quality A', 'Quality Bank A', 'BRL'),
             ($2, $4, $6, 'PLUGGY', 'quality-account-b', 'CHECKING',
              'Quality B', 'Quality Bank B', 'BRL')`,
          [accountA, accountB, workspaceA, workspaceB, connectionA, connectionB],
        );
        await pool.query(
          `insert into category (id, workspace_id, code, kind, name_en, name_pt_br) values
             ($1::uuid, $4, 'custom.' || $1::text, 'EXPENSE', 'Rule', 'Regra'),
             ($2::uuid, $4, 'custom.' || $2::text, 'EXPENSE', 'User', 'Usuário'),
             ($3::uuid, $5, 'custom.' || $3::text, 'EXPENSE', 'Provider', 'Provedor')`,
          [categoryA, categoryUser, categoryB, workspaceA, workspaceB],
        );
        await pool.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key, review_status)
           values ($1, $2, 'Mercado Seguro', 'mercado seguro', 'CONFIRMED')`,
          [merchantA, workspaceA],
        );

        for (const [
          id,
          workspaceId,
          accountId,
          transactionDate,
          categoryId,
          categorySource,
          status,
          merchantId,
          providerCurrency,
          accountAmount,
          description,
        ] of [
          [
            ruleTransaction,
            workspaceA,
            accountA,
            '2026-08-24',
            categoryA,
            'RULE',
            'POSTED',
            null,
            'BRL',
            '-10.000000',
            'Rule classified',
          ],
          [
            merchantTransaction,
            workspaceA,
            accountA,
            '2026-08-24',
            categoryA,
            'MERCHANT',
            'POSTED',
            merchantA,
            'BRL',
            '-20.000000',
            'Merchant classified',
          ],
          [
            userTransaction,
            workspaceA,
            accountA,
            '2026-08-23',
            null,
            'NONE',
            'POSTED',
            null,
            'BRL',
            '-30.000000',
            'User classified',
          ],
          [
            missingTransaction,
            workspaceA,
            accountA,
            '2026-08-22',
            null,
            'NONE',
            'POSTED',
            merchantA,
            'USD',
            null,
            'Missing category',
          ],
          [
            explicitlyClearedTransaction,
            workspaceA,
            accountA,
            '2026-08-24',
            categoryA,
            'RULE',
            'POSTED',
            null,
            'BRL',
            '-40.000000',
            'Explicitly cleared',
          ],
          [
            deletedTransaction,
            workspaceA,
            accountA,
            '2026-08-24',
            null,
            'NONE',
            'DELETED',
            null,
            'BRL',
            '-50.000000',
            'Deleted unclassified',
          ],
          [
            otherWorkspaceTransaction,
            workspaceB,
            accountB,
            '2026-08-24',
            categoryB,
            'PROVIDER',
            'POSTED',
            null,
            'BRL',
            '-60.000000',
            'Other workspace',
          ],
        ] as const) {
          await pool.query(
            `insert into financial_transaction (
               id, workspace_id, financial_account_id, provider, provider_transaction_id,
               status, provider_type, provider_amount_signed, provider_currency,
               account_currency_amount_signed, account_currency, system_direction,
               system_financial_role, system_category_id, system_category_source,
               provider_transaction_at, transaction_local_date, description_original,
               description_normalized, system_merchant_id, system_merchant_source,
               provider_category_name, dedupe_fingerprint, deleted_at
             ) values (
               $1, $2, $3, 'PLUGGY', $4, $5, 'DEBIT', '-10.000000', $6,
               $7, 'BRL', 'OUTFLOW', 'PURCHASE', $8, $9,
               ($10::date + time '12:00') at time zone 'UTC', $10, $11, lower($11),
               $12, case when $12::uuid is null then 'NONE' else 'MERCHANT' end,
               case when $8::uuid is null then null else 'Synthetic Provider Category' end,
               $13, case when $5 = 'DELETED' then now() else null end
             )`,
            [
              id,
              workspaceId,
              accountId,
              `quality-${id}`,
              status,
              providerCurrency,
              accountAmount,
              categoryId,
              categorySource,
              transactionDate,
              description,
              merchantId,
              fingerprint(`${workspaceId}:${id}`),
            ],
          );
        }
        await pool.query(
          `insert into transaction_user_state (
             financial_transaction_id, workspace_id, category_override_enabled,
             category_id_override, updated_by_actor_type
           ) values ($1, $3, true, $4, 'USER'), ($2, $3, true, null, 'USER')`,
          [userTransaction, explicitlyClearedTransaction, workspaceA, categoryUser],
        );

        const report = await repository.getReport(workspaceA);
        expect(report).toMatchObject({
          classifiedCount: 3,
          totalCount: 5,
          unclassifiedCount: 2,
          unclassifiedPercentage: '40.0000',
          workspaceId: workspaceA,
        });
        expect(report.sourceDistribution.map(({ source }) => source)).toEqual(
          classificationQualitySources,
        );
        expect(
          Object.fromEntries(
            report.sourceDistribution.map(({ source, count, percentage }) => [
              source,
              { count, percentage },
            ]),
          ),
        ).toEqual({
          HEURISTIC: { count: 0, percentage: '0.0000' },
          MERCHANT: { count: 1, percentage: '20.0000' },
          MODEL: { count: 0, percentage: '0.0000' },
          PROVIDER: { count: 0, percentage: '0.0000' },
          RULE: { count: 1, percentage: '20.0000' },
          UNATTRIBUTED: { count: 0, percentage: '0.0000' },
          UNCLASSIFIED: { count: 2, percentage: '40.0000' },
          USER: { count: 1, percentage: '20.0000' },
        });
        await expect(repository.getReport(workspaceB)).resolves.toMatchObject({
          classifiedCount: 1,
          totalCount: 1,
          unclassifiedCount: 0,
          unclassifiedPercentage: '0.0000',
        });

        const firstPage = await repository.listUnclassified(workspaceA, { limit: 1 });
        expect(firstPage.items).toHaveLength(1);
        expect(firstPage.items[0]).toMatchObject({
          accountCurrencyAmountSigned: '-40.000000',
          categorySource: 'USER',
          descriptionOriginal: 'Explicitly cleared',
          id: explicitlyClearedTransaction,
          merchantId: null,
          transactionLocalDate: '2026-08-24',
        });
        expect(firstPage.nextCursor).toEqual({
          id: explicitlyClearedTransaction,
          transactionLocalDate: '2026-08-24',
        });
        if (firstPage.nextCursor === null) throw new Error('Expected an unclassified cursor.');
        const secondPage = await repository.listUnclassified(workspaceA, {
          cursor: firstPage.nextCursor,
          limit: 1,
        });
        expect(secondPage).toMatchObject({
          items: [
            {
              accountCurrencyAmountSigned: null,
              categorySource: 'NONE',
              hasUnconvertedCurrency: true,
              id: missingTransaction,
              merchantId: merchantA,
              merchantName: 'Mercado Seguro',
              transactionLocalDate: '2026-08-22',
            },
          ],
          nextCursor: null,
        });
        await expect(repository.listUnclassified(workspaceB)).resolves.toEqual({
          items: [],
          nextCursor: null,
        });
        await expect(repository.listUnclassified(workspaceA, { limit: 101 })).rejects.toThrow(
          /limit/u,
        );
        await expect(
          repository.listUnclassified(workspaceA, {
            cursor: { id: 'not-a-uuid', transactionLocalDate: parseBankDate('2026-08-24') },
          }),
        ).rejects.toThrow(/UUID/u);
      } finally {
        await pool.end();
      }
    } finally {
      await admin.query(`drop database if exists ${quoteDatabase(databaseName)} with (force)`);
      await admin.end();
    }
  }, 30_000);
});
