import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { webUnclassifiedTransactionSchema } from '@cashcount/contracts';
import {
  ClassificationQualityRepository,
  createDatabaseClient,
  PayloadEncryptionService,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
  TransactionImportRepository,
} from '@cashcount/db';
import { providerTransactionSchema, type ProviderTransactionDto } from '@cashcount/provider-core';
import {
  currencyTimezoneFixtureAccountId,
  currencyTimezoneTransactionFixtures,
} from '@cashcount/test-fixtures';
import { describe, expect, it } from 'vitest';

import { importTransactions } from './transaction-import.js';

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_currency_timezone_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected currency/timezone database identifier.');
  }
  return `"${identifier}"`;
}

interface EffectRow {
  account_currency: string;
  account_currency_amount_signed: string | null;
  analytics_amount_signed: string | null;
  cashflow_effect_amount: string | null;
  has_unconverted_currency: boolean;
  provider_amount_signed: string;
  provider_currency: string;
  provider_transaction_at: Date;
  provider_transaction_id: string;
  spend_effect_amount: string | null;
  transaction_local_date: string;
  workspace_id: string;
}

describe('currency and timezone import regression', () => {
  it('preserves dual-currency evidence and derives dates from each workspace IANA timezone', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_currency_timezone_${randomUUID().replaceAll('-', '')}`;
    const testUrl = new URL(databaseUrl);
    testUrl.pathname = `/${databaseName}`;
    const admin = createDatabaseClient(databaseUrl);

    try {
      await admin.pool.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(testUrl.toString());
      await seedSyntheticIdentity(testUrl.toString(), 'test');
      const client = createDatabaseClient(testUrl.toString());
      client.pool.on('error', () => undefined);

      try {
        const saoPauloWorkspace = syntheticIdentitySeed.workspace.id;
        const tokyoWorkspace = '20000000-0000-4000-8000-000000000058';
        const saoPauloConnection = '30000000-0000-4000-8000-000000000058';
        const tokyoConnection = '30000000-0000-4000-8000-000000000059';
        const saoPauloAccount = '40000000-0000-4000-8000-000000000062';
        const tokyoAccount = '40000000-0000-4000-8000-000000000063';
        await client.pool.query(
          `insert into workspace (id, name, base_currency, timezone)
           values ($1, 'Tokyo Currency Regression', 'BRL', 'Asia/Tokyo')`,
          [tokyoWorkspace],
        );
        await client.pool.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values
             ($1, $3, 'PLUGGY', 'currency-timezone-sp', 'synthetic', 'Synthetic SP Bank'),
             ($2, $4, 'PLUGGY', 'currency-timezone-tokyo', 'synthetic', 'Synthetic Tokyo Bank')`,
          [saoPauloConnection, tokyoConnection, saoPauloWorkspace, tokyoWorkspace],
        );
        await client.pool.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency
           ) values
             ($1, $3, $5, 'PLUGGY', $7, 'CHECKING',
              'Synthetic SP Account', 'Synthetic SP Bank', 'BRL'),
             ($2, $4, $6, 'PLUGGY', $7, 'CHECKING',
              'Synthetic Tokyo Account', 'Synthetic Tokyo Bank', 'BRL')`,
          [
            saoPauloAccount,
            tokyoAccount,
            saoPauloWorkspace,
            tokyoWorkspace,
            saoPauloConnection,
            tokyoConnection,
            currencyTimezoneFixtureAccountId,
          ],
        );

        const transactions: ProviderTransactionDto[] = currencyTimezoneTransactionFixtures.map(
          ({ input }) => providerTransactionSchema.parse(input),
        );
        const encryption = new PayloadEncryptionService({
          activeKeyVersion: 12,
          keyring: new Map([[12, new Uint8Array(32).fill(58)]]),
        });
        const persistence = new TransactionImportRepository(client.database);
        const runImport = async (workspaceId: string, providerConnectionId: string, now: Date) =>
          importTransactions({
            encryption,
            now: () => now,
            persistence,
            provider: {
              listTransactions: async ({ cursor, externalAccountId }) => {
                expect(cursor).toBeNull();
                expect(externalAccountId).toBe(currencyTimezoneFixtureAccountId);
                return { items: transactions, nextCursor: null };
              },
            },
            providerConnectionId,
            triggerType: 'INITIAL',
            workspaceId,
          });

        await expect(
          runImport(saoPauloWorkspace, saoPauloConnection, new Date('2026-08-24T10:00:00Z')),
        ).resolves.toMatchObject({
          transactionsInserted: 4,
          transactionsSeen: 4,
          transactionsUpdated: 0,
        });
        await expect(
          runImport(tokyoWorkspace, tokyoConnection, new Date('2026-08-24T10:01:00Z')),
        ).resolves.toMatchObject({
          transactionsInserted: 4,
          transactionsSeen: 4,
          transactionsUpdated: 0,
        });
        await expect(
          runImport(saoPauloWorkspace, saoPauloConnection, new Date('2026-08-24T10:02:00Z')),
        ).resolves.toMatchObject({
          transactionsInserted: 0,
          transactionsSeen: 4,
          transactionsUpdated: 0,
        });

        const effects = await client.pool.query<EffectRow>(
          `select spend.workspace_id, spend.provider_transaction_id,
                  spend.provider_amount_signed::text, spend.provider_currency,
                  spend.account_currency_amount_signed::text, spend.account_currency,
                  spend.analytics_amount_signed::text, spend.has_unconverted_currency,
                  spend.transaction_local_date::text, spend.provider_transaction_at,
                  spend.spend_effect_amount::text, cash.cashflow_effect_amount::text
           from v_transaction_spend_effect spend
           join v_transaction_cashflow_effect cash
             on cash.workspace_id = spend.workspace_id and cash.id = spend.id
           where spend.workspace_id in ($1, $2)
           order by spend.workspace_id, spend.provider_transaction_id`,
          [saoPauloWorkspace, tokyoWorkspace],
        );
        expect(effects.rows).toHaveLength(8);
        for (const workspaceId of [saoPauloWorkspace, tokyoWorkspace]) {
          for (const fixture of currencyTimezoneTransactionFixtures) {
            const row = effects.rows.find(
              (candidate) =>
                candidate.workspace_id === workspaceId &&
                candidate.provider_transaction_id === fixture.input.externalTransactionId,
            );
            if (row === undefined) throw new Error(`Missing persisted fixture ${fixture.name}.`);
            expect(row).toMatchObject({
              account_currency: 'BRL',
              account_currency_amount_signed: fixture.expected.accountAmountSigned,
              analytics_amount_signed: fixture.expected.analyticsAmountSigned,
              cashflow_effect_amount: fixture.expected.cashflowEffectAmount,
              has_unconverted_currency: fixture.expected.hasUnconvertedCurrency,
              provider_amount_signed: fixture.input.amountSigned,
              provider_currency: fixture.input.currency,
              spend_effect_amount: fixture.expected.spendEffectAmount,
              transaction_local_date:
                workspaceId === saoPauloWorkspace
                  ? fixture.expected.saoPauloDate
                  : fixture.expected.tokyoDate,
            });
            expect(row.provider_transaction_at.toISOString()).toBe(
              fixture.expected.providerInstant,
            );
          }
        }

        const monthly = await client.pool.query<{
          spend_amount: string;
          transaction_count: string;
          unconverted_transaction_count: string;
          workspace_id: string;
        }>(
          `select workspace_id, spend_amount::text, transaction_count::text,
                  unconverted_transaction_count::text
           from v_monthly_spend_by_category
           where workspace_id in ($1, $2) and month = '2026-08-01' and category_id is null
           order by workspace_id`,
          [saoPauloWorkspace, tokyoWorkspace],
        );
        expect(monthly.rows).toEqual([
          {
            spend_amount: '86.654323',
            transaction_count: '3',
            unconverted_transaction_count: '1',
            workspace_id: saoPauloWorkspace,
          },
          {
            spend_amount: '86.654323',
            transaction_count: '3',
            unconverted_transaction_count: '1',
            workspace_id: tokyoWorkspace,
          },
        ]);

        const qualityRepository = new ClassificationQualityRepository(client.pool);
        const queue = await qualityRepository.listUnclassified(saoPauloWorkspace, { limit: 10 });
        const unconverted = queue.items.find(
          ({ descriptionNormalized }) =>
            descriptionNormalized === 'synthetic unconverted boundary purchase',
        );
        if (unconverted === undefined) throw new Error('Expected the unconverted review item.');
        expect(unconverted).toMatchObject({
          accountCurrency: 'BRL',
          accountCurrencyAmountSigned: null,
          hasUnconvertedCurrency: true,
          transactionLocalDate: '2026-08-24',
        });
        expect(
          webUnclassifiedTransactionSchema.parse({
            amount: {
              currency: unconverted.accountCurrency,
              hasUnconvertedCurrency: unconverted.hasUnconvertedCurrency,
              value: unconverted.accountCurrencyAmountSigned,
            },
            category: null,
            classificationState: 'UNCLASSIFIED',
            description: {
              normalized: unconverted.descriptionNormalized,
              original: unconverted.descriptionOriginal,
            },
            id: unconverted.id,
            merchant: null,
            providerCategoryName: null,
            transactionDate: unconverted.transactionLocalDate,
            warnings: ['MISSING_CATEGORY', 'MISSING_MERCHANT', 'UNCONVERTED_CURRENCY'],
          }),
        ).toMatchObject({
          amount: { currency: 'BRL', hasUnconvertedCurrency: true, value: null },
        });
        const review = await client.pool.query<{ count: number }>(
          `select count(*)::integer as count from v_transactions_needing_review
           where workspace_id = $1 and id = $2 and has_unconverted_currency`,
          [saoPauloWorkspace, unconverted.id],
        );
        expect(review.rows[0]?.count).toBe(1);
        const rawCount = await client.pool.query<{ count: number }>(
          `select count(*)::integer as count from provider_raw_object
           where entity_type = 'TRANSACTION' and key_version = 12`,
        );
        expect(rawCount.rows[0]?.count).toBe(8);
      } finally {
        await client.pool.end();
      }
    } finally {
      await admin.pool.query(`drop database if exists ${quoteDatabase(databaseName)}`);
      await admin.pool.end();
    }
  }, 30_000);
});
