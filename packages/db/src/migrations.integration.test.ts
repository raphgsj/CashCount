import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDatabaseConfig } from '@cashcount/config';
import {
  providerAccountSchema,
  providerBillSchema,
  providerTransactionSchema,
  type ProviderAccountDto,
  type ProviderBillDto,
  type ProviderConnectionDto,
  type ProviderTransactionDto,
} from '@cashcount/provider-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  AccountImportInvariantError,
  AccountImportRepository,
} from './account-import-repository.js';
import { AccountHistoryCoverageRepository } from './account-history-coverage-repository.js';
import { BillImportInvariantError, BillImportRepository } from './bill-import-repository.js';
import { PayloadEncryptionService, payloadCanonicalizationVersion } from './encryption.js';
import { defaultMigrationsFolder, runMigrations } from './migrations.js';
import { ProviderConnectionRepository } from './provider-connection-repository.js';
import * as schema from './schema.js';
import { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';
import {
  TransactionImportInvariantError,
  TransactionImportRepository,
} from './transaction-import-repository.js';
import {
  TransactionNotFoundError,
  TransactionUserStateConflictError,
  TransactionUserStateRepository,
} from './transaction-user-state-repository.js';

interface CountResult {
  count: number;
}

interface MigrationJournal {
  dialect: string;
  entries: readonly MigrationJournalEntry[];
  version: string;
}

interface MigrationJournalEntry {
  tag: string;
}

interface WorkspaceForeignKeyAuditRow {
  child_columns: string[];
  child_table: string;
  constraint_name: string;
  parent_columns: string[];
  parent_has_workspace_candidate_key: boolean;
  parent_table: string;
}

interface SyntheticTransactionInput {
  accountId: string;
  billId?: string;
  categoryId?: string;
  id: string;
  latestRawObjectId?: string;
  merchantId?: string;
  providerTransactionId: string;
  workspaceId: string;
}

function quoteIdentifier(identifier: string): string {
  if (!/^cashcount_migration_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected test database identifier.');
  }

  return `"${identifier}"`;
}

async function withTemporaryDatabase(
  run: (connectionString: string) => Promise<void>,
): Promise<void> {
  const { databaseUrl } = parseDatabaseConfig(process.env);
  const databaseName = `cashcount_migration_${randomUUID().replaceAll('-', '')}`;
  const quotedDatabaseName = quoteIdentifier(databaseName);
  const temporaryDatabaseUrl = new URL(databaseUrl);
  const adminClient = new Client({ connectionString: databaseUrl });
  let databaseCreated = false;

  temporaryDatabaseUrl.pathname = `/${databaseName}`;

  try {
    await adminClient.connect();
    await adminClient.query(`CREATE DATABASE ${quotedDatabaseName} TEMPLATE template0`);
    databaseCreated = true;
    await run(temporaryDatabaseUrl.toString());
  } finally {
    if (databaseCreated) {
      await adminClient.query(`DROP DATABASE ${quotedDatabaseName} WITH (FORCE)`);
    }

    await adminClient.end();
  }
}

async function createPartialMigrationFolder(entryCount: number): Promise<string> {
  const migrationFolder = await mkdtemp(join(tmpdir(), 'cashcount-partial-migrations-'));
  const metadataFolder = join(migrationFolder, 'meta');
  const journal = JSON.parse(
    await readFile(join(defaultMigrationsFolder, 'meta', '_journal.json'), 'utf8'),
  ) as MigrationJournal;

  await mkdir(metadataFolder);
  await Promise.all(
    journal.entries.slice(0, entryCount).map(async ({ tag }) => {
      await copyFile(
        join(defaultMigrationsFolder, `${tag}.sql`),
        join(migrationFolder, `${tag}.sql`),
      );
    }),
  );
  await writeFile(
    join(metadataFolder, '_journal.json'),
    `${JSON.stringify({ ...journal, entries: journal.entries.slice(0, entryCount) }, null, 2)}\n`,
    'utf8',
  );

  return migrationFolder;
}

async function queryCount(client: Client, query: string): Promise<number | undefined> {
  const result = await client.query<CountResult>(query);

  return result.rows[0]?.count;
}

async function insertSyntheticTransaction(
  client: Client,
  input: SyntheticTransactionInput,
): Promise<void> {
  await client.query(
    `insert into financial_transaction (
      id, workspace_id, financial_account_id, provider, provider_transaction_id, status,
      provider_type, provider_amount_signed, provider_currency, account_currency,
      system_direction, system_financial_role, provider_transaction_at,
      transaction_local_date, description_original, description_normalized,
      system_merchant_id, system_category_id, credit_card_bill_id, dedupe_fingerprint,
      latest_raw_object_id
    ) values (
      $1, $2, $3, 'PLUGGY', $4, 'POSTED', 'DEBIT', '-123.450000', 'BRL', 'BRL',
      'OUTFLOW', 'PURCHASE', '2026-08-20T15:30:00Z', '2026-08-20',
      'Synthetic transaction', 'synthetic transaction', $5, $6, $7, $8, $9
    )`,
    [
      input.id,
      input.workspaceId,
      input.accountId,
      input.providerTransactionId,
      input.merchantId ?? null,
      input.categoryId ?? null,
      input.billId ?? null,
      'b'.repeat(64),
      input.latestRawObjectId ?? null,
    ],
  );
}

describe('database migrations', () => {
  it('runs from zero, remains idempotent, and seeds synthetic identity data', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });

      try {
        await client.connect();
        expect(
          await queryCount(
            client,
            'select count(*)::integer as count from drizzle.__drizzle_migrations',
          ),
        ).toBe(9);
        expect(
          await queryCount(
            client,
            "select count(*)::integer as count from pg_tables where schemaname = 'public'",
          ),
        ).toBe(29);
        expect(
          await queryCount(
            client,
            "select count(*)::integer as count from information_schema.views where table_schema = 'public' and table_name like 'v_%'",
          ),
        ).toBe(12);
        expect(
          await queryCount(
            client,
            "select count(*)::integer as count from pg_indexes where schemaname = 'public' and indexname in ('transaction_user_state_workspace_review_idx', 'transaction_identity_link_workspace_review_idx', 'bill_payment_reconciliation_workspace_status_idx', 'installment_series_workspace_status_idx', 'recurring_series_workspace_status_next_idx')",
          ),
        ).toBe(5);
        expect(
          await queryCount(
            client,
            "select count(*)::integer as count from pg_extension where extname = 'citext'",
          ),
        ).toBe(1);
        await client.query(
          `insert into encryption_rotation_run (from_key_version, to_key_version, status, current_table, rows_examined, rows_reencrypted) values (1, 2, 'PAUSED', 'provider_raw_object', 10, 4)`,
        );
        await expect(
          client.query(
            `insert into encryption_rotation_run (from_key_version, to_key_version) values (2, 2)`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into encryption_rotation_run (from_key_version, to_key_version, rows_examined, rows_reencrypted) values (1, 2, 1, 2)`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from app_user where id = '${syntheticIdentitySeed.user.id}'`,
          ),
        ).toBe(1);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from workspace where id = '${syntheticIdentitySeed.workspace.id}'`,
          ),
        ).toBe(1);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from workspace_member where workspace_id = '${syntheticIdentitySeed.workspace.id}' and user_id = '${syntheticIdentitySeed.user.id}' and role = 'OWNER'`,
          ),
        ).toBe(1);

        await expect(
          client.query(
            `insert into app_user (email, auth_provider, auth_subject) values ('owner@example.test', 'other', 'other')`,
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into app_user (email, auth_provider, auth_subject) values ('other@example.test', '${syntheticIdentitySeed.user.authProvider}', '${syntheticIdentitySeed.user.authSubject}')`,
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into app_user (email, auth_provider, auth_subject) values ('UPPER@example.test', 'other', 'upper')`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into app_user (email, auth_provider, auth_subject, status) values ('status@example.test', 'other', 'status', 'PENDING')`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into workspace (name, base_currency, timezone, analytics_policy_version) values ('Invalid Currency', 'brl', 'America/Sao_Paulo', 1)`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into workspace_member (workspace_id, user_id, role) values ('${syntheticIdentitySeed.workspace.id}', '${syntheticIdentitySeed.user.id}', 'OWNER')`,
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into workspace_member (workspace_id, user_id, role) values ('${syntheticIdentitySeed.workspace.id}', '30000000-0000-4000-8000-000000000001', 'OWNER')`,
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await expect(
          client.query(
            `insert into workspace_member (workspace_id, user_id, role) values ('${syntheticIdentitySeed.workspace.id}', '${syntheticIdentitySeed.user.id}', 'EDITOR')`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(`delete from workspace where id = '${syntheticIdentitySeed.workspace.id}'`),
        ).rejects.toMatchObject({ code: '23001' });
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('imports encrypted bills idempotently without synthesizing financial transactions', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceId = syntheticIdentitySeed.workspace.id;
      const providerConnectionId = '40000000-0000-4000-8000-000000000034';
      const checkingAccountId = '60000000-0000-4000-8000-000000000035';
      const cardAccountId = '60000000-0000-4000-8000-000000000036';
      const transactionId = '80000000-0000-4000-8000-000000000034';
      const externalBillId = 'synthetic-bill-import-bill';
      const externalCardId = 'synthetic-bill-import-card';
      const encryption = new PayloadEncryptionService({
        activeKeyVersion: 10,
        keyring: new Map([[10, new Uint8Array(32).fill(34)]]),
      });
      const bill = (revision = 'initial'): ProviderBillDto =>
        providerBillSchema.parse({
          allowsInstallments: null,
          closeDate: null,
          currency: 'BRL',
          dueDate: '2026-09-10',
          externalAccountId: externalCardId,
          externalBillId,
          financeCharges: [
            {
              additionalInfo: revision === 'initial' ? null : 'updated evidence',
              amount: revision === 'initial' ? '1.230000' : '2.340000',
              chargeType: 'IOF',
              currency: 'BRL',
              externalChargeId: 'synthetic-bill-finance-charge',
              raw: { confidentialMarker: 'charge-secret', revision },
            },
          ],
          minimumPayment: null,
          payments: [
            {
              amount: revision === 'initial' ? '100.000000' : '110.000000',
              currency: 'BRL',
              externalPaymentId: 'synthetic-bill-payment',
              paymentDate: '2026-08-20',
              paymentMode: null,
              raw: { confidentialMarker: 'payment-secret', revision },
              valueType: 'FULL_PAYMENT',
            },
          ],
          providerStatus: null,
          providerUpdatedAt: null,
          raw: { confidentialMarker: 'bill-secret', revision },
          status: 'UNKNOWN',
          totalAmount: revision === 'initial' ? '250.000000' : '260.000000',
        });

      try {
        await client.connect();
        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, $2, 'PLUGGY', 'synthetic-bill-import-item', 'synthetic-connector', 'Synthetic Fixture Bank')`,
          [providerConnectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency, masked_number
           ) values
             ($1, $2, $3, 'PLUGGY', 'synthetic-bill-checking', 'CHECKING', 'Synthetic checking', 'Synthetic Bank', 'BRL', '6789'),
             ($4, $2, $3, 'PLUGGY', $5, 'CREDIT_CARD', 'Synthetic card', 'Synthetic Bank', 'BRL', '4321')`,
          [checkingAccountId, workspaceId, providerConnectionId, cardAccountId, externalCardId],
        );
        await client.query(
          `insert into financial_transaction (
             id, workspace_id, financial_account_id, provider, provider_transaction_id,
             provider_bill_id, status, provider_type, provider_amount_signed,
             provider_currency, account_currency, system_direction, system_financial_role,
             provider_transaction_at, transaction_local_date, description_original,
             description_normalized, dedupe_fingerprint
           ) values (
             $1, $2, $3, 'PLUGGY', 'synthetic-bill-unresolved-transaction', $4,
             'POSTED', 'CREDIT', '-25.000000', 'BRL', 'BRL', 'INFLOW', 'UNKNOWN_CREDIT',
             '2026-08-25T12:00:00Z', '2026-08-25', 'Synthetic unresolved card credit',
             'synthetic unresolved card credit', $5
           )`,
          [transactionId, workspaceId, cardAccountId, externalBillId, 'c'.repeat(64)],
        );

        const repository = new BillImportRepository(drizzle({ client, schema }));
        expect(await repository.getImportTarget(randomUUID(), providerConnectionId)).toBeNull();
        const target = await repository.getImportTarget(workspaceId, providerConnectionId);
        expect(target).toEqual({
          accounts: [{ externalAccountId: externalCardId, financialAccountId: cardAccountId }],
          localStatus: 'ACTIVE',
        });
        const account = target?.accounts[0];
        if (account === undefined) throw new Error('Expected a credit-card import target.');

        await expect(
          repository.importBills(
            workspaceId,
            providerConnectionId,
            account,
            [bill()],
            encryption,
            new Date('2026-08-23T18:00:00.000Z'),
          ),
        ).resolves.toEqual({
          billsInserted: 1,
          billsSeen: 1,
          billsUpdated: 0,
          financeChargesInserted: 1,
          financeChargesUpdated: 0,
          paymentsInserted: 1,
          paymentsUpdated: 0,
          rawSnapshotsInserted: 3,
          transactionsLinked: 1,
        });

        const normalized = await client.query<{
          allows_installments: null | boolean;
          close_date: null | string;
          minimum_payment: null | string;
          provider_status: null | string;
          total_amount: string;
        }>(
          `select allows_installments, close_date::text as close_date,
                  minimum_payment, provider_status, total_amount
           from credit_card_bill where workspace_id = $1 and external_bill_id = $2`,
          [workspaceId, externalBillId],
        );
        expect(normalized.rows).toEqual([
          {
            allows_installments: null,
            close_date: null,
            minimum_payment: null,
            provider_status: null,
            total_amount: '250.000000',
          },
        ]);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from financial_transaction where workspace_id = '${workspaceId}'`,
          ),
        ).toBe(1);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from financial_transaction where workspace_id = '${workspaceId}' and id = '${transactionId}' and credit_card_bill_id is not null and system_financial_role = 'UNKNOWN_CREDIT'`,
          ),
        ).toBe(1);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from provider_raw_object where workspace_id = '${workspaceId}' and key_version = 10 and entity_type in ('BILL', 'BILL_PAYMENT', 'BILL_FINANCE_CHARGE')`,
          ),
        ).toBe(3);

        const repeated = await repository.importBills(
          workspaceId,
          providerConnectionId,
          account,
          [bill()],
          encryption,
          new Date('2026-08-23T19:00:00.000Z'),
        );
        expect(repeated).toMatchObject({
          billsInserted: 0,
          billsUpdated: 0,
          financeChargesInserted: 0,
          financeChargesUpdated: 0,
          paymentsInserted: 0,
          paymentsUpdated: 0,
          rawSnapshotsInserted: 0,
          transactionsLinked: 0,
        });

        const updated = await repository.importBills(
          workspaceId,
          providerConnectionId,
          account,
          [bill('updated')],
          encryption,
          new Date('2026-08-23T20:00:00.000Z'),
        );
        expect(updated).toMatchObject({
          billsUpdated: 1,
          financeChargesUpdated: 1,
          paymentsUpdated: 1,
          rawSnapshotsInserted: 3,
        });
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from credit_card_bill_payment where workspace_id = '${workspaceId}'`,
          ),
        ).toBe(1);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from credit_card_bill_finance_charge where workspace_id = '${workspaceId}'`,
          ),
        ).toBe(1);

        await expect(
          repository.importBills(
            workspaceId,
            providerConnectionId,
            { ...account, externalAccountId: 'mismatched-account' },
            [bill()],
            encryption,
          ),
        ).rejects.toBeInstanceOf(BillImportInvariantError);
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('imports transaction pages idempotently with exact evidence, coverage, and user-state isolation', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceId = syntheticIdentitySeed.workspace.id;
      const providerConnectionId = '40000000-0000-4000-8000-000000000033';
      const checkingAccountId = '60000000-0000-4000-8000-000000000033';
      const cardAccountId = '60000000-0000-4000-8000-000000000034';
      const billId = '70000000-0000-4000-8000-000000000033';
      const externalConnectionId = 'synthetic-transaction-import-item';
      const externalCheckingId = 'synthetic-transaction-checking';
      const externalCardId = 'synthetic-transaction-card';
      const externalBillId = 'synthetic-transaction-bill';
      const encryption = new PayloadEncryptionService({
        activeKeyVersion: 9,
        keyring: new Map([[9, new Uint8Array(32).fill(33)]]),
      });
      const checkingTransaction = (
        overrides: Record<string, unknown> = {},
      ): ProviderTransactionDto =>
        providerTransactionSchema.parse({
          accountCurrency: 'BRL',
          amountInAccountCurrencySigned: '-67.890000',
          amountSigned: '-12.340000',
          categoryId: null,
          categoryName: null,
          creditCardMetadata: null,
          currency: 'USD',
          description: '  Synthetic   Foreign Purchase  ',
          descriptionRaw: null,
          externalAccountId: externalCheckingId,
          externalTransactionId: 'synthetic-checking-transaction',
          merchant: null,
          operationType: null,
          operationTypeAdditionalInfo: null,
          providerCode: null,
          providerId: null,
          providerType: 'DEBIT',
          purchaseAt: null,
          raw: { confidentialMarker: 'checking-secret', revision: 'initial' },
          status: 'POSTED',
          transactionAt: '2026-08-24T01:30:00.000Z',
          ...overrides,
        });
      const cardTransaction = (overrides: Record<string, unknown> = {}): ProviderTransactionDto =>
        providerTransactionSchema.parse({
          accountCurrency: 'BRL',
          amountInAccountCurrencySigned: null,
          amountSigned: '-25.000000',
          categoryId: 'provider-category-hint',
          categoryName: 'Optional hint',
          creditCardMetadata: {
            billForecastMonth: '2026-08',
            billId: externalBillId,
            cardLastFour: '4321',
            feeType: null,
            feeTypeAdditionalInfo: null,
            installmentNumber: null,
            mcc: null,
            otherCreditAdditionalInfo: null,
            otherCreditType: null,
            totalAmount: null,
            totalInstallments: null,
          },
          currency: 'BRL',
          description: 'Synthetic unresolved card credit',
          descriptionRaw: null,
          externalAccountId: externalCardId,
          externalTransactionId: 'synthetic-card-transaction',
          merchant: null,
          operationType: null,
          operationTypeAdditionalInfo: null,
          providerCode: null,
          providerId: null,
          providerType: 'CREDIT',
          purchaseAt: null,
          raw: { confidentialMarker: 'card-secret', revision: 'initial' },
          status: 'POSTED',
          transactionAt: '2026-08-25T12:00:00.000Z',
          ...overrides,
        });

      try {
        await client.connect();
        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, $2, 'PLUGGY', $3, 'synthetic-connector', 'Synthetic Fixture Bank')`,
          [providerConnectionId, workspaceId, externalConnectionId],
        );
        await client.query(
          `insert into financial_account (
             id, workspace_id, provider_connection_id, provider, external_account_id,
             account_type, name, institution_name, currency, masked_number
           ) values
             ($1, $2, $3, 'PLUGGY', $4, 'CHECKING', 'Synthetic checking', 'Synthetic Bank', 'BRL', '6789'),
             ($5, $2, $3, 'PLUGGY', $6, 'CREDIT_CARD', 'Synthetic card', 'Synthetic Bank', 'BRL', '4321')`,
          [
            checkingAccountId,
            workspaceId,
            providerConnectionId,
            externalCheckingId,
            cardAccountId,
            externalCardId,
          ],
        );
        await client.query(
          `insert into credit_card_bill (
             id, workspace_id, financial_account_id, provider, external_bill_id, status, currency
           ) values ($1, $2, $3, 'PLUGGY', $4, 'OPEN', 'BRL')`,
          [billId, workspaceId, cardAccountId, externalBillId],
        );

        const repository = new TransactionImportRepository(drizzle({ client, schema }));
        await expect(
          repository.startSync(randomUUID(), providerConnectionId, 'INITIAL'),
        ).rejects.toBeInstanceOf(TransactionImportInvariantError);

        const runImport = async (
          checking: readonly ProviderTransactionDto[],
          card: ProviderTransactionDto,
          observedAt: Date,
        ) => {
          const started = await repository.startSync(
            workspaceId,
            providerConnectionId,
            'INITIAL',
            observedAt,
          );
          const checkingAccount = started.accounts.find(
            (candidate) => candidate.financialAccountId === checkingAccountId,
          );
          const cardAccount = started.accounts.find(
            (candidate) => candidate.financialAccountId === cardAccountId,
          );
          if (checkingAccount === undefined || cardAccount === undefined) {
            throw new Error('Expected both transaction import accounts.');
          }
          const checkingResult = await repository.importPage(
            workspaceId,
            started.syncRunId,
            checkingAccount,
            checking,
            null,
            encryption,
            observedAt,
          );
          const cardResult = await repository.importPage(
            workspaceId,
            started.syncRunId,
            cardAccount,
            [card],
            null,
            encryption,
            observedAt,
          );
          await repository.completeAccount(
            workspaceId,
            started.syncRunId,
            checkingAccountId,
            observedAt,
          );
          await repository.completeAccount(
            workspaceId,
            started.syncRunId,
            cardAccountId,
            observedAt,
          );
          const completed = await repository.completeSync(
            workspaceId,
            started.syncRunId,
            observedAt,
          );
          return { cardResult, checkingResult, completed };
        };

        const initial = await runImport(
          [checkingTransaction()],
          cardTransaction(),
          new Date('2026-08-23T13:00:00.000Z'),
        );
        expect(initial.completed).toMatchObject({
          accountsSeen: 2,
          transactionsDeleted: 0,
          transactionsInserted: 2,
          transactionsSeen: 2,
          transactionsUpdated: 0,
        });
        expect(initial.checkingResult.rawSnapshotsInserted).toBe(1);
        expect(initial.cardResult.rawSnapshotsInserted).toBe(1);

        const normalized = await client.query<{
          account_currency: string;
          account_currency_amount_signed: null | string;
          credit_card_bill_id: null | string;
          description_normalized: string;
          provider_amount_signed: string;
          provider_currency: string;
          provider_transaction_id: string;
          system_direction: string;
          system_financial_role: string;
          system_financial_role_source: string;
          transaction_local_date: string;
        }>(
          `select provider_transaction_id, provider_amount_signed, provider_currency,
                  account_currency_amount_signed, account_currency,
                  transaction_local_date::text as transaction_local_date,
                  description_normalized, system_direction, system_financial_role,
                  system_financial_role_source,
                  credit_card_bill_id
           from financial_transaction
           where workspace_id = $1
           order by provider_transaction_id`,
          [workspaceId],
        );
        expect(normalized.rows).toEqual([
          {
            account_currency: 'BRL',
            account_currency_amount_signed: null,
            credit_card_bill_id: billId,
            description_normalized: 'synthetic unresolved card credit',
            provider_amount_signed: '-25.000000',
            provider_currency: 'BRL',
            provider_transaction_id: 'synthetic-card-transaction',
            system_direction: 'INFLOW',
            system_financial_role: 'UNKNOWN_CREDIT',
            system_financial_role_source: 'HEURISTIC',
            transaction_local_date: '2026-08-25',
          },
          {
            account_currency: 'BRL',
            account_currency_amount_signed: '-67.890000',
            credit_card_bill_id: null,
            description_normalized: 'synthetic foreign purchase',
            provider_amount_signed: '-12.340000',
            provider_currency: 'USD',
            provider_transaction_id: 'synthetic-checking-transaction',
            system_direction: 'OUTFLOW',
            system_financial_role: 'PURCHASE',
            system_financial_role_source: 'HEURISTIC',
            transaction_local_date: '2026-08-23',
          },
        ]);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from provider_raw_object where entity_type = 'TRANSACTION' and key_version = 9`,
          ),
        ).toBe(2);
        expect(
          await queryCount(client, `select count(*)::integer as count from transaction_user_state`),
        ).toBe(0);
        const coverage = await client.query<{
          history_coverage_note: string;
          history_coverage_status: string;
          provider_history_earliest_date: string;
          provider_history_latest_date: string;
        }>(
          `select history_coverage_status, history_coverage_note,
                  provider_history_earliest_date::text as provider_history_earliest_date,
                  provider_history_latest_date::text as provider_history_latest_date
           from financial_account where id = $1`,
          [checkingAccountId],
        );
        expect(coverage.rows[0]).toEqual({
          history_coverage_note:
            'Provider history begins 2026-08-23; earlier activity may be unavailable.',
          history_coverage_status: 'PARTIAL',
          provider_history_earliest_date: '2026-08-23',
          provider_history_latest_date: '2026-08-23',
        });
        const coverageRepository = new AccountHistoryCoverageRepository(
          drizzle({ client, schema }),
        );
        await expect(
          coverageRepository.getForRange(workspaceId, '2026-01-01', [checkingAccountId]),
        ).resolves.toMatchObject([
          {
            accountId: checkingAccountId,
            coverageStatus: 'PARTIAL',
            warning: {
              availableFrom: '2026-08-23',
              code: 'INCOMPLETE_HISTORY',
              requestedFrom: '2026-01-01',
            },
          },
        ]);
        await expect(
          coverageRepository.getForRange(workspaceId, '2026-08-23', [checkingAccountId]),
        ).resolves.toMatchObject([{ warning: null }]);
        await expect(
          coverageRepository.getForRange(randomUUID(), '2026-01-01', [checkingAccountId]),
        ).resolves.toEqual([]);

        const repeated = await runImport(
          [checkingTransaction()],
          cardTransaction(),
          new Date('2026-08-23T14:00:00.000Z'),
        );
        expect(repeated.completed).toMatchObject({
          transactionsDeleted: 0,
          transactionsInserted: 0,
          transactionsSeen: 2,
          transactionsUpdated: 0,
        });
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from provider_raw_object where entity_type = 'TRANSACTION'`,
          ),
        ).toBe(2);

        const checkingRow = await client.query<{ id: string }>(
          `select id from financial_transaction
           where workspace_id = $1 and provider_transaction_id = 'synthetic-checking-transaction'`,
          [workspaceId],
        );
        const checkingTransactionId = checkingRow.rows[0]?.id;
        if (checkingTransactionId === undefined) throw new Error('Expected checking transaction.');
        await client.query(
          `insert into transaction_user_state (
             financial_transaction_id, workspace_id, notes, review_status,
             updated_by_actor_type, updated_by_actor_id
           ) values ($1, $2, 'Manual note survives sync', 'CONFIRMED', 'USER', 'synthetic-owner')`,
          [checkingTransactionId, workspaceId],
        );

        const deleted = checkingTransaction({
          raw: { confidentialMarker: 'checking-secret', revision: 'deleted' },
          status: 'DELETED',
        });
        const deletionRun = await runImport(
          [deleted],
          cardTransaction(),
          new Date('2026-08-23T15:00:00.000Z'),
        );
        expect(deletionRun.completed).toMatchObject({
          transactionsDeleted: 1,
          transactionsInserted: 0,
          transactionsUpdated: 0,
        });
        const repeatedDeletionRun = await runImport(
          [deleted],
          cardTransaction(),
          new Date('2026-08-23T15:30:00.000Z'),
        );
        expect(repeatedDeletionRun.completed).toMatchObject({
          transactionsDeleted: 0,
          transactionsInserted: 0,
          transactionsUpdated: 0,
        });
        const reappeared = checkingTransaction({
          raw: { confidentialMarker: 'checking-secret', revision: 'reappeared' },
        });
        const reappearanceRun = await runImport(
          [reappeared],
          cardTransaction(),
          new Date('2026-08-23T16:00:00.000Z'),
        );
        expect(reappearanceRun.completed).toMatchObject({
          transactionsDeleted: 0,
          transactionsInserted: 0,
          transactionsUpdated: 1,
        });
        const stateAfterSync = await client.query<{
          deleted_at: Date | null;
          notes: string;
          review_status: string;
          version: number;
        }>(
          `select ft.deleted_at, tus.notes, tus.review_status, tus.version
           from financial_transaction ft
           join transaction_user_state tus on tus.workspace_id = ft.workspace_id
             and tus.financial_transaction_id = ft.id
           where ft.workspace_id = $1 and ft.id = $2`,
          [workspaceId, checkingTransactionId],
        );
        expect(stateAfterSync.rows).toEqual([
          {
            deleted_at: null,
            notes: 'Manual note survives sync',
            review_status: 'CONFIRMED',
            version: 1,
          },
        ]);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from transaction_revision where financial_transaction_id = '${checkingTransactionId}'`,
          ),
        ).toBe(2);

        const collision = checkingTransaction({
          externalTransactionId: 'synthetic-checking-collision',
          raw: { confidentialMarker: 'collision-secret' },
        });
        const collisionRun = await runImport(
          [reappeared, collision],
          cardTransaction(),
          new Date('2026-08-23T17:00:00.000Z'),
        );
        expect(collisionRun.completed).toMatchObject({
          transactionsInserted: 1,
          transactionsSeen: 3,
        });
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from financial_transaction where workspace_id = '${workspaceId}' and duplicate_review_status = 'POSSIBLE'`,
          ),
        ).toBe(2);
        expect(
          await queryCount(client, `select count(*)::integer as count from transaction_user_state`),
        ).toBe(1);

        const deepHistory = checkingTransaction({
          externalTransactionId: 'synthetic-checking-history-boundary',
          raw: { confidentialMarker: 'history-secret' },
          transactionAt: '2025-08-22T12:00:00.000Z',
        });
        const deepHistoryRun = await runImport(
          [deepHistory],
          cardTransaction(),
          new Date('2026-08-23T18:00:00.000Z'),
        );
        expect(deepHistoryRun.completed).toMatchObject({ transactionsInserted: 1 });
        const maximumCoverage = await client.query<{
          history_coverage_note: string;
          history_coverage_status: string;
          provider_history_earliest_date: string;
          provider_history_latest_date: string;
        }>(
          `select history_coverage_status, history_coverage_note,
                  provider_history_earliest_date::text as provider_history_earliest_date,
                  provider_history_latest_date::text as provider_history_latest_date
           from financial_account where id = $1`,
          [checkingAccountId],
        );
        expect(maximumCoverage.rows[0]).toEqual({
          history_coverage_note:
            'Observed provider history spans at least the documented maximum window.',
          history_coverage_status: 'PROVIDER_MAXIMUM_RETRIEVED',
          provider_history_earliest_date: '2025-08-22',
          provider_history_latest_date: '2026-08-23',
        });
        await expect(
          coverageRepository.getForRange(workspaceId, '2025-08-22', [checkingAccountId]),
        ).resolves.toMatchObject([{ coverageStatus: 'PROVIDER_MAXIMUM_RETRIEVED', warning: null }]);
        await expect(
          coverageRepository.getForRange(workspaceId, '2025-08-21', [checkingAccountId]),
        ).resolves.toMatchObject([
          {
            coverageStatus: 'PROVIDER_MAXIMUM_RETRIEVED',
            warning: { code: 'INCOMPLETE_HISTORY', requestedFrom: '2025-08-21' },
          },
        ]);
        await client.query(
          `update financial_account
           set history_coverage_status = 'USER_EXTENDED_HISTORY',
               history_coverage_note = 'Synthetic owner import extends provider history.'
           where workspace_id = $1 and id = $2`,
          [workspaceId, checkingAccountId],
        );
        await runImport([deepHistory], cardTransaction(), new Date('2026-08-23T19:00:00.000Z'));
        await expect(
          coverageRepository.getForRange(workspaceId, '2025-08-22', [checkingAccountId]),
        ).resolves.toMatchObject([
          {
            coverageNote: 'Synthetic owner import extends provider history.',
            coverageStatus: 'USER_EXTENDED_HISTORY',
            warning: null,
          },
        ]);
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('encrypts account evidence and idempotently upserts only masked normalized accounts', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceId = syntheticIdentitySeed.workspace.id;
      const providerConnectionId = '40000000-0000-4000-8000-000000000031';
      const externalConnectionId = 'synthetic-account-import-item';
      const externalAccountId = 'synthetic-account-import-account';
      const encryption = new PayloadEncryptionService({
        activeKeyVersion: 7,
        keyring: new Map([[7, new Uint8Array(32).fill(31)]]),
      });
      const account: ProviderAccountDto = providerAccountSchema.parse({
        accountSubtype: 'CHECKING_ACCOUNT',
        accountType: 'CHECKING',
        availableBalance: '123.450000',
        availableCreditLimit: null,
        closingDay: null,
        creditLimit: null,
        currency: 'BRL',
        currentBalance: '123.450000',
        dueDay: null,
        externalAccountId,
        externalConnectionId,
        institutionName: 'Synthetic Fixture Bank',
        isActive: true,
        maskedNumber: '6789',
        name: 'Synthetic checking',
        providerUpdatedAt: '2026-08-23T12:00:00.000Z',
        raw: { confidentialAccountNumber: '000123456789', revision: 'first' },
      });

      try {
        await client.connect();
        await client.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, $2, 'PLUGGY', $3, 'synthetic-connector', 'Synthetic Fixture Bank')`,
          [providerConnectionId, workspaceId, externalConnectionId],
        );
        const repository = new AccountImportRepository(drizzle({ client, schema }));
        await expect(
          repository.getImportTarget(workspaceId, providerConnectionId),
        ).resolves.toEqual({ externalConnectionId, localStatus: 'ACTIVE' });
        await expect(repository.getImportTarget(randomUUID(), providerConnectionId)).resolves.toBe(
          null,
        );

        await expect(
          repository.importAccounts(
            workspaceId,
            providerConnectionId,
            externalConnectionId,
            [account],
            encryption,
            new Date('2026-08-23T13:00:00.000Z'),
          ),
        ).resolves.toEqual({
          accountsInserted: 1,
          accountsSeen: 1,
          accountsUpdated: 0,
          rawSnapshotsInserted: 1,
        });

        const normalized = await client.query<{
          current_balance: string;
          latest_raw_object_id: string;
          masked_number: string;
        }>(
          `select current_balance, latest_raw_object_id, masked_number
           from financial_account
           where workspace_id = $1 and provider = 'PLUGGY' and external_account_id = $2`,
          [workspaceId, externalAccountId],
        );
        expect(normalized.rows).toHaveLength(1);
        expect(normalized.rows[0]).toMatchObject({
          current_balance: '123.450000',
          masked_number: '6789',
        });
        const latestRawObjectId = normalized.rows[0]?.latest_raw_object_id;
        expect(latestRawObjectId).toBeTypeOf('string');

        const evidence = await client.query<{
          canonicalization_version: string;
          id: string;
          key_version: number;
          payload_ciphertext: Buffer;
          payload_iv: Buffer;
          payload_sha256: string;
          payload_tag: Buffer;
        }>(
          `select id, payload_ciphertext, payload_iv, payload_tag, key_version,
                  payload_sha256, canonicalization_version
           from provider_raw_object
           where workspace_id = $1 and provider = 'PLUGGY' and entity_type = 'ACCOUNT'
             and external_id = $2`,
          [workspaceId, externalAccountId],
        );
        expect(evidence.rows).toHaveLength(1);
        const rawSnapshot = evidence.rows[0];
        if (rawSnapshot === undefined) throw new Error('Expected encrypted account evidence.');
        expect(rawSnapshot.id).toBe(latestRawObjectId);
        expect(rawSnapshot.key_version).toBe(7);
        expect(rawSnapshot.canonicalization_version).toBe(payloadCanonicalizationVersion);
        expect(rawSnapshot.payload_ciphertext.toString('utf8')).not.toContain('000123456789');
        expect(
          encryption.decryptJson(
            {
              authenticationTag: rawSnapshot.payload_tag,
              canonicalizationVersion: payloadCanonicalizationVersion,
              ciphertext: rawSnapshot.payload_ciphertext,
              keyVersion: rawSnapshot.key_version,
              nonce: rawSnapshot.payload_iv,
              payloadSha256: rawSnapshot.payload_sha256,
            },
            {
              entityType: 'ACCOUNT',
              externalId: externalAccountId,
              provider: 'PLUGGY',
              recordId: rawSnapshot.id,
              storageTable: 'provider_raw_object',
              workspaceId,
            },
          ),
        ).toEqual({ confidentialAccountNumber: '000123456789', revision: 'first' });

        await expect(
          repository.importAccounts(
            workspaceId,
            providerConnectionId,
            externalConnectionId,
            [account],
            encryption,
            new Date('2026-08-23T14:00:00.000Z'),
          ),
        ).resolves.toEqual({
          accountsInserted: 0,
          accountsSeen: 1,
          accountsUpdated: 1,
          rawSnapshotsInserted: 0,
        });
        const updatedAccount = providerAccountSchema.parse({
          ...account,
          currentBalance: '200.100000',
          raw: { confidentialAccountNumber: '000123456789', revision: 'second' },
        });
        await expect(
          repository.importAccounts(
            workspaceId,
            providerConnectionId,
            externalConnectionId,
            [updatedAccount],
            encryption,
            new Date('2026-08-23T15:00:00.000Z'),
          ),
        ).resolves.toMatchObject({
          accountsInserted: 0,
          accountsUpdated: 1,
          rawSnapshotsInserted: 1,
        });
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from provider_raw_object where entity_type = 'ACCOUNT'`,
          ),
        ).toBe(2);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from financial_account where workspace_id = '${workspaceId}' and external_account_id = '${externalAccountId}'`,
          ),
        ).toBe(1);

        await expect(
          repository.importAccounts(
            workspaceId,
            providerConnectionId,
            externalConnectionId,
            [{ ...account, externalConnectionId: 'different-item' }],
            encryption,
          ),
        ).rejects.toBeInstanceOf(AccountImportInvariantError);
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('assigns discovered provider connections without persisting raw evidence', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceId = syntheticIdentitySeed.workspace.id;
      const discoveredConnection: ProviderConnectionDto = {
        actionRequiredAt: null,
        consentExpiresAt: '2026-11-23T12:00:00.000Z',
        displayName: 'Synthetic Fixture Bank',
        errorCode: null,
        executionStatus: 'SUCCESS',
        externalConnectionId: 'synthetic-discovered-item',
        externalConnectorId: 'synthetic-connector',
        itemStatus: 'UPDATED',
        localStatus: 'ACTIVE',
        providerUpdatedAt: '2026-08-23T12:00:00.000Z',
        raw: { confidentialFixtureMarker: 'must-not-persist' },
      };

      try {
        await client.connect();
        const repository = new ProviderConnectionRepository(drizzle({ client, schema }));
        await expect(repository.workspaceExists(workspaceId)).resolves.toBe(true);
        await expect(repository.workspaceExists(randomUUID())).resolves.toBe(false);
        await expect(
          repository.assignDiscoveredConnections(workspaceId, [discoveredConnection]),
        ).resolves.toMatchObject([{ localStatus: 'ACTIVE' }]);

        const inserted = await client.query<{
          display_name: string;
          external_connection_id: string;
          local_status: string;
        }>(
          `select display_name, external_connection_id, local_status
           from provider_connection
           where workspace_id = $1 and provider = 'PLUGGY' and external_connection_id = $2`,
          [workspaceId, discoveredConnection.externalConnectionId],
        );
        expect(inserted.rows).toEqual([
          {
            display_name: 'Synthetic Fixture Bank',
            external_connection_id: 'synthetic-discovered-item',
            local_status: 'ACTIVE',
          },
        ]);
        const rawEvidence = await client.query<CountResult>(
          `select count(*)::integer as count from provider_raw_object`,
        );
        expect(rawEvidence.rows[0]?.count).toBe(0);

        await client.query(
          `update provider_connection set local_status = 'DISABLED'
           where workspace_id = $1 and provider = 'PLUGGY' and external_connection_id = $2`,
          [workspaceId, discoveredConnection.externalConnectionId],
        );
        await expect(
          repository.assignDiscoveredConnections(workspaceId, [
            { ...discoveredConnection, displayName: 'Updated Fixture Bank' },
          ]),
        ).resolves.toMatchObject([{ localStatus: 'DISABLED' }]);
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('enforces provider scope, encrypted evidence, webhook idempotency, queue dedupe, and sync scope', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceA = syntheticIdentitySeed.workspace.id;
      const workspaceB = '20000000-0000-4000-8000-000000000002';
      const connectionA = '40000000-0000-4000-8000-000000000001';
      const connectionB = '40000000-0000-4000-8000-000000000002';
      const sha256 = 'a'.repeat(64);
      const envelopeSql =
        "decode('01', 'hex'), decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex')";

      try {
        await client.connect();
        await client.query(
          `insert into workspace (id, name) values ($1, 'Second Synthetic Workspace')`,
          [workspaceB],
        );
        await client.query(
          `insert into provider_connection (id, workspace_id, provider, external_connection_id, external_connector_id, display_name) values ($1, $2, 'PLUGGY', 'shared-item', 'synthetic-connector', 'Synthetic Connection A')`,
          [connectionA, workspaceA],
        );
        await client.query(
          `insert into provider_connection (id, workspace_id, provider, external_connection_id, external_connector_id, display_name) values ($1, $2, 'PLUGGY', 'shared-item', 'synthetic-connector', 'Synthetic Connection B')`,
          [connectionB, workspaceB],
        );

        await expect(
          client.query(
            `insert into provider_connection (workspace_id, provider, external_connection_id, external_connector_id, display_name) values ($1, 'PLUGGY', 'shared-item', 'other-connector', 'Duplicate')`,
            [workspaceA],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into sync_run (workspace_id, provider_connection_id, trigger_type) values ($1, $2, 'INITIAL')`,
            [workspaceB, connectionA],
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await client.query(
          `insert into sync_run (workspace_id, provider_connection_id, trigger_type) values ($1, $2, 'INITIAL')`,
          [workspaceA, connectionA],
        );
        await expect(
          client.query(
            `insert into sync_run (workspace_id, provider_connection_id, trigger_type, transactions_seen) values ($1, $2, 'MANUAL', -1)`,
            [workspaceA, connectionA],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into provider_raw_object (workspace_id, provider, entity_type, external_id, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256, observed_at) values ($1, 'PLUGGY', 'ITEM', 'shared-item', ${envelopeSql}, 1, $2, now()), ($1, 'PLUGGY', 'ITEM', 'shared-item', ${envelopeSql}, 1, $2, now() + interval '1 second')`,
          [workspaceA, sha256],
        );
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from provider_raw_object where workspace_id = '${workspaceA}' and external_id = 'shared-item'`,
          ),
        ).toBe(2);
        await expect(
          client.query(
            `insert into provider_raw_object (workspace_id, provider, entity_type, external_id, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256, observed_at) values ($1, 'PLUGGY', 'ITEM', 'invalid-envelope', decode('', 'hex'), decode('02', 'hex'), decode('03', 'hex'), 1, $2, now())`,
            [workspaceA, sha256],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into webhook_event (workspace_id, provider, external_event_id, event_type, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256) values ($1, 'PLUGGY', 'shared-event', 'transactions/created', ${envelopeSql}, 1, $2)`,
          [workspaceA, sha256],
        );
        await expect(
          client.query(
            `insert into webhook_event (workspace_id, provider, external_event_id, event_type, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256) values ($1, 'PLUGGY', 'shared-event', 'transactions/created', ${envelopeSql}, 1, $2)`,
            [workspaceA, sha256],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await client.query(
          `insert into webhook_event (workspace_id, provider, external_event_id, event_type, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256) values ($1, 'PLUGGY', 'shared-event', 'transactions/created', ${envelopeSql}, 1, $2)`,
          [workspaceB, sha256],
        );
        await client.query(
          `insert into webhook_event (provider, external_event_id, event_type, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256, status) values ('PLUGGY', 'unmapped-event', 'transactions/created', ${envelopeSql}, 1, $1, 'UNMAPPED')`,
          [sha256],
        );
        await expect(
          client.query(
            `insert into webhook_event (provider, external_event_id, event_type, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256, status) values ('PLUGGY', 'unmapped-event', 'transactions/created', ${envelopeSql}, 1, $1, 'UNMAPPED')`,
            [sha256],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into webhook_event (provider, external_event_id, event_type, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256) values ('PLUGGY', 'invalid-unmapped-event', 'transactions/created', ${envelopeSql}, 1, $1)`,
            [sha256],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        const firstJob = await client.query<{ id: string }>(
          `insert into job_queue (workspace_id, job_type, dedupe_key, max_attempts) values ($1, 'SYNC_CONNECTION', 'connection:shared-item', 5) returning id`,
          [workspaceA],
        );
        await expect(
          client.query(
            `insert into job_queue (workspace_id, job_type, dedupe_key, status, max_attempts) values ($1, 'SYNC_CONNECTION', 'connection:shared-item', 'RETRY', 5)`,
            [workspaceA],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await client.query(
          `update job_queue set status = 'SUCCEEDED', finished_at = now() where id = $1`,
          [firstJob.rows[0]?.id],
        );
        await client.query(
          `insert into job_queue (workspace_id, job_type, dedupe_key, max_attempts) values ($1, 'SYNC_CONNECTION', 'connection:shared-item', 5)`,
          [workspaceA],
        );
        await client.query(
          `insert into job_queue (job_type, dedupe_key, max_attempts) values ('SYSTEM_REPAIR', 'repair:one', 3)`,
        );
        await expect(
          client.query(
            `insert into job_queue (job_type, dedupe_key, max_attempts) values ('SYSTEM_REPAIR', 'repair:one', 3)`,
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into job_queue (workspace_id, job_type, status, max_attempts) values ($1, 'SYNC_CONNECTION', 'RUNNING', 5)`,
            [workspaceA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('enforces financial identities, workspace isolation, category visibility, and reconciliation roles', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceA = syntheticIdentitySeed.workspace.id;
      const workspaceB = '20000000-0000-4000-8000-000000000002';
      const connectionA = '40000000-0000-4000-8000-000000000001';
      const connectionB = '40000000-0000-4000-8000-000000000002';
      const rawA = '50000000-0000-4000-8000-000000000001';
      const rawB = '50000000-0000-4000-8000-000000000002';
      const checkingAccountA = '60000000-0000-4000-8000-000000000001';
      const cardAccountA = '60000000-0000-4000-8000-000000000002';
      const cardAccountB = '60000000-0000-4000-8000-000000000003';
      const billA = '70000000-0000-4000-8000-000000000001';
      const billB = '70000000-0000-4000-8000-000000000002';
      const builtinCategory = '80000000-0000-4000-8000-000000000001';
      const customCategoryA = '80000000-0000-4000-8000-000000000002';
      const customCategoryB = '80000000-0000-4000-8000-000000000003';
      const merchantA = '90000000-0000-4000-8000-000000000001';
      const merchantB = '90000000-0000-4000-8000-000000000002';
      const cardTransactionA = 'a0000000-0000-4000-8000-000000000001';
      const successorTransactionA = 'a0000000-0000-4000-8000-000000000002';
      const alternateSuccessorA = 'a0000000-0000-4000-8000-000000000003';
      const bankTransactionA = 'a0000000-0000-4000-8000-000000000004';
      const secondBankTransactionA = 'a0000000-0000-4000-8000-000000000005';
      const cardTransactionB = 'a0000000-0000-4000-8000-000000000006';
      const billPaymentA = 'b0000000-0000-4000-8000-000000000001';
      const sha256 = 'a'.repeat(64);
      const customCode = `custom.${customCategoryA}`;
      const envelopeSql =
        "decode('01', 'hex'), decode(repeat('02', 12), 'hex'), decode(repeat('03', 16), 'hex')";

      try {
        await client.connect();
        await client.query(`insert into workspace (id, name) values ($1, 'Second Workspace')`, [
          workspaceB,
        ]);
        await client.query(
          `insert into provider_connection (id, workspace_id, provider, external_connection_id, external_connector_id, display_name) values ($1, $2, 'PLUGGY', 'shared-item', 'connector', 'Connection A'), ($3, $4, 'PLUGGY', 'shared-item', 'connector', 'Connection B')`,
          [connectionA, workspaceA, connectionB, workspaceB],
        );
        await client.query(
          `insert into provider_raw_object (id, workspace_id, provider, entity_type, external_id, payload_ciphertext, payload_iv, payload_tag, key_version, payload_sha256, observed_at) values ($1, $2, 'PLUGGY', 'ACCOUNT', 'account-a', ${envelopeSql}, 1, $3, now()), ($4, $5, 'PLUGGY', 'ACCOUNT', 'account-b', ${envelopeSql}, 1, $3, now())`,
          [rawA, workspaceA, sha256, rawB, workspaceB],
        );

        await client.query(
          `insert into financial_account (id, workspace_id, provider_connection_id, provider, external_account_id, account_type, name, institution_name, currency, masked_number, latest_raw_object_id) values
            ($1, $2, $3, 'PLUGGY', 'shared-account', 'CHECKING', 'Checking A', 'Synthetic Bank', 'BRL', '1234', $4),
            ($5, $2, $3, 'PLUGGY', 'card-a', 'CREDIT_CARD', 'Card A', 'Synthetic Bank', 'BRL', '5678', $4),
            ($6, $7, $8, 'PLUGGY', 'shared-account', 'CREDIT_CARD', 'Card B', 'Synthetic Bank', 'BRL', '9012', $9)`,
          [
            checkingAccountA,
            workspaceA,
            connectionA,
            rawA,
            cardAccountA,
            cardAccountB,
            workspaceB,
            connectionB,
            rawB,
          ],
        );
        await expect(
          client.query(
            `insert into financial_account (workspace_id, provider_connection_id, provider, external_account_id, account_type, name, institution_name, currency) values ($1, $2, 'PLUGGY', 'shared-account', 'OTHER', 'Duplicate', 'Synthetic Bank', 'BRL')`,
            [workspaceA, connectionA],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into financial_account (workspace_id, provider_connection_id, provider, external_account_id, account_type, name, institution_name, currency) values ($1, $2, 'PLUGGY', 'cross-connection', 'OTHER', 'Cross Connection', 'Synthetic Bank', 'BRL')`,
            [workspaceA, connectionB],
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await expect(
          client.query(
            `insert into financial_account (workspace_id, provider_connection_id, provider, external_account_id, account_type, name, institution_name, currency, latest_raw_object_id) values ($1, $2, 'PLUGGY', 'cross-raw', 'OTHER', 'Cross Raw', 'Synthetic Bank', 'BRL', $3)`,
            [workspaceA, connectionA, rawB],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        await client.query(
          `insert into credit_card_bill (id, workspace_id, financial_account_id, provider, external_bill_id, status, total_amount, currency) values ($1, $2, $3, 'PLUGGY', 'shared-bill', 'OPEN', '500.000000', 'BRL'), ($4, $5, $6, 'PLUGGY', 'shared-bill', 'OPEN', '500.000000', 'BRL')`,
          [billA, workspaceA, cardAccountA, billB, workspaceB, cardAccountB],
        );
        await expect(
          client.query(
            `insert into credit_card_bill (workspace_id, financial_account_id, provider, external_bill_id, status, currency) values ($1, $2, 'PLUGGY', 'checking-bill', 'OPEN', 'BRL')`,
            [workspaceA, checkingAccountA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into credit_card_bill (workspace_id, financial_account_id, provider, external_bill_id, status, currency) values ($1, $2, 'PLUGGY', 'cross-bill', 'OPEN', 'BRL')`,
            [workspaceA, cardAccountB],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into category (id, code, kind, name_en, name_pt_br) values ($1, 'expense.food', 'EXPENSE', 'Food', 'Alimentação')`,
          [builtinCategory],
        );
        await client.query(
          `insert into category (id, workspace_id, code, parent_id, kind, name_en, name_pt_br) values ($1, $2, $3, $4, 'EXPENSE', 'Custom A', 'Personalizada A'), ($5, $6, $3, null, 'EXPENSE', 'Custom B', 'Personalizada B')`,
          [customCategoryA, workspaceA, customCode, builtinCategory, customCategoryB, workspaceB],
        );
        await expect(
          client.query(
            `insert into category (workspace_id, code, kind, name_en, name_pt_br) values ($1, 'expense.invalid', 'EXPENSE', 'Invalid', 'Inválida')`,
            [workspaceA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into category (code, parent_id, kind, name_en, name_pt_br) values ('expense.invalid_parent', $1, 'EXPENSE', 'Invalid', 'Inválida')`,
            [customCategoryA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into category (workspace_id, code, parent_id, kind, name_en, name_pt_br) values ($1, 'custom.80000000-0000-4000-8000-000000000004', $2, 'EXPENSE', 'Invalid', 'Inválida')`,
            [workspaceA, customCategoryB],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(`update category set code = 'expense.changed' where id = $1`, [
            builtinCategory,
          ]),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key, default_category_id) values ($1, $2, 'Merchant A', 'merchant-a', $3), ($4, $5, 'Merchant B', 'merchant-b', null)`,
          [merchantA, workspaceA, builtinCategory, merchantB, workspaceB],
        );
        await expect(
          client.query(
            `insert into merchant (workspace_id, canonical_name, normalized_key, default_category_id) values ($1, 'Cross Category', 'cross-category', $2)`,
            [workspaceA, customCategoryB],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into merchant_alias (workspace_id, merchant_id, alias_normalized, match_type, source, confidence) values ($1, $2, 'cross-alias', 'EXACT', 'USER', '1.0000')`,
            [workspaceA, merchantB],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        await insertSyntheticTransaction(client, {
          accountId: cardAccountA,
          billId: billA,
          categoryId: customCategoryA,
          id: cardTransactionA,
          latestRawObjectId: rawA,
          merchantId: merchantA,
          providerTransactionId: 'shared-provider-transaction',
          workspaceId: workspaceA,
        });
        await insertSyntheticTransaction(client, {
          accountId: cardAccountA,
          id: successorTransactionA,
          providerTransactionId: 'successor-a',
          workspaceId: workspaceA,
        });
        await insertSyntheticTransaction(client, {
          accountId: cardAccountA,
          id: alternateSuccessorA,
          providerTransactionId: 'alternate-successor-a',
          workspaceId: workspaceA,
        });
        await insertSyntheticTransaction(client, {
          accountId: checkingAccountA,
          id: bankTransactionA,
          providerTransactionId: 'bank-payment-a',
          workspaceId: workspaceA,
        });
        await insertSyntheticTransaction(client, {
          accountId: checkingAccountA,
          id: secondBankTransactionA,
          providerTransactionId: 'bank-payment-a-2',
          workspaceId: workspaceA,
        });
        await insertSyntheticTransaction(client, {
          accountId: cardAccountB,
          id: cardTransactionB,
          latestRawObjectId: rawB,
          providerTransactionId: 'shared-provider-transaction',
          workspaceId: workspaceB,
        });
        await client.query(
          `update financial_transaction
           set system_financial_role = 'CARD_BILL_PAYMENT',
               system_financial_role_source = 'HEURISTIC',
               system_is_excluded_from_spend = true,
               system_exclusion_source = 'HEURISTIC'
           where id in ($1, $2)`,
          [bankTransactionA, secondBankTransactionA],
        );

        const exactAmounts = await client.query<{
          account_amount: string | null;
          provider_amount: string;
        }>(
          `select account_currency_amount_signed::text as account_amount, provider_amount_signed::text as provider_amount from financial_transaction where id = $1`,
          [cardTransactionA],
        );
        expect(exactAmounts.rows[0]).toEqual({
          account_amount: null,
          provider_amount: '-123.450000',
        });
        await expect(
          insertSyntheticTransaction(client, {
            accountId: cardAccountA,
            id: 'a0000000-0000-4000-8000-000000000010',
            providerTransactionId: 'shared-provider-transaction',
            workspaceId: workspaceA,
          }),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          insertSyntheticTransaction(client, {
            accountId: cardAccountA,
            id: 'a0000000-0000-4000-8000-000000000011',
            merchantId: merchantB,
            providerTransactionId: 'cross-merchant',
            workspaceId: workspaceA,
          }),
        ).rejects.toMatchObject({ code: '23503' });
        await expect(
          insertSyntheticTransaction(client, {
            accountId: cardAccountA,
            categoryId: customCategoryB,
            id: 'a0000000-0000-4000-8000-000000000012',
            providerTransactionId: 'cross-category',
            workspaceId: workspaceA,
          }),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          insertSyntheticTransaction(client, {
            accountId: cardAccountA,
            id: 'a0000000-0000-4000-8000-000000000013',
            latestRawObjectId: rawB,
            providerTransactionId: 'cross-raw',
            workspaceId: workspaceA,
          }),
        ).rejects.toMatchObject({ code: '23503' });
        await expect(
          insertSyntheticTransaction(client, {
            accountId: checkingAccountA,
            billId: billA,
            id: 'a0000000-0000-4000-8000-000000000014',
            providerTransactionId: 'wrong-bill-account',
            workspaceId: workspaceA,
          }),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(`update financial_transaction set transfer_pair_id = id where id = $1`, [
            cardTransactionA,
          ]),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(`update financial_transaction set transfer_pair_id = $1 where id = $2`, [
            cardTransactionB,
            cardTransactionA,
          ]),
        ).rejects.toMatchObject({ code: '23503' });

        await client.query(
          `insert into transaction_user_state (financial_transaction_id, workspace_id, category_override_enabled, category_id_override, merchant_override_enabled, merchant_id_override, notes, updated_by_actor_type) values ($1, $2, true, $3, true, $4, 'Synthetic note', 'USER')`,
          [cardTransactionA, workspaceA, builtinCategory, merchantA],
        );
        await expect(
          client.query(
            `insert into transaction_user_state (financial_transaction_id, workspace_id, category_override_enabled, category_id_override, updated_by_actor_type) values ($1, $2, true, $3, 'USER')`,
            [successorTransactionA, workspaceA, customCategoryB],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into transaction_user_state (financial_transaction_id, workspace_id, updated_by_actor_type) values ($1, $2, 'USER')`,
            [cardTransactionB, workspaceA],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        const identityLink = await client.query<{ id: string }>(
          `insert into transaction_identity_link (workspace_id, predecessor_transaction_id, successor_transaction_id, confidence) values ($1, $2, $3, '0.9400') returning id`,
          [workspaceA, cardTransactionA, successorTransactionA],
        );
        await expect(
          client.query(
            `insert into transaction_identity_link (workspace_id, predecessor_transaction_id, successor_transaction_id) values ($1, $2, $2)`,
            [workspaceA, cardTransactionA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into transaction_identity_link (workspace_id, predecessor_transaction_id, successor_transaction_id) values ($1, $2, $3)`,
            [workspaceA, cardTransactionA, cardTransactionB],
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await client.query(
          `update transaction_identity_link set status = 'AUTO_CONFIRMED', confirmed_at = now() where id = $1`,
          [identityLink.rows[0]?.id],
        );
        await expect(
          client.query(
            `insert into transaction_identity_link (workspace_id, predecessor_transaction_id, successor_transaction_id, status, confirmed_at) values ($1, $2, $3, 'USER_CONFIRMED', now())`,
            [workspaceA, cardTransactionA, alternateSuccessorA],
          ),
        ).rejects.toMatchObject({ code: '23505' });

        await client.query(
          `insert into transaction_revision (workspace_id, financial_transaction_id, change_type, changed_fields, actor_type) values ($1, $2, 'PROVIDER_UPDATE', '{"status":{"from":"PENDING","to":"POSTED"}}', 'WORKER')`,
          [workspaceA, cardTransactionA],
        );
        await expect(
          client.query(
            `insert into transaction_revision (workspace_id, financial_transaction_id, change_type, changed_fields, actor_type) values ($1, $2, 'PROVIDER_UPDATE', '{}', 'WORKER')`,
            [workspaceA, cardTransactionB],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        await client.query(
          `insert into credit_card_bill_payment (id, workspace_id, credit_card_bill_id, provider, external_payment_id, value_type, payment_date, amount, currency, matched_card_transaction_id, latest_raw_object_id) values ($1, $2, $3, 'PLUGGY', 'payment-a', 'FULL_PAYMENT', '2026-08-21', '123.450000', 'BRL', $4, $5)`,
          [billPaymentA, workspaceA, billA, cardTransactionA, rawA],
        );
        await expect(
          client.query(
            `insert into credit_card_bill_payment (workspace_id, credit_card_bill_id, provider, external_payment_id, value_type, payment_date, amount, currency) values ($1, $2, 'PLUGGY', 'payment-a', 'FULL_PAYMENT', '2026-08-21', '123.450000', 'BRL')`,
            [workspaceA, billA],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into credit_card_bill_payment (workspace_id, credit_card_bill_id, provider, external_payment_id, value_type, payment_date, amount, currency, matched_card_transaction_id) values ($1, $2, 'PLUGGY', 'payment-bank', 'FULL_PAYMENT', '2026-08-21', '123.450000', 'BRL', $3)`,
            [workspaceA, billA, bankTransactionA],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into credit_card_bill_finance_charge (workspace_id, credit_card_bill_id, provider, external_charge_id, charge_type, amount, currency, matched_transaction_id) values ($1, $2, 'PLUGGY', 'charge-a', 'IOF', '1.230000', 'BRL', $3)`,
          [workspaceA, billA, cardTransactionA],
        );
        await expect(
          client.query(
            `insert into credit_card_bill_finance_charge (workspace_id, credit_card_bill_id, provider, external_charge_id, charge_type, amount, currency) values ($1, $2, 'PLUGGY', 'negative-charge', 'IOF', '-1.000000', 'BRL')`,
            [workspaceA, billA],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into bill_payment_reconciliation (workspace_id, credit_card_bill_payment_id, financial_transaction_id, match_status, match_method, confidence, matched_at) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
          [workspaceA, billPaymentA, bankTransactionA],
        );
        await expect(
          client.query(
            `insert into bill_payment_reconciliation (workspace_id, credit_card_bill_payment_id, financial_transaction_id, match_status, match_method, matched_at, confirmed_by) values ($1, $2, $3, 'USER_CONFIRMED', 'USER', now(), 'synthetic-owner')`,
            [workspaceA, billPaymentA, secondBankTransactionA],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into bill_payment_reconciliation (workspace_id, credit_card_bill_payment_id, financial_transaction_id, match_status, match_method) values ($1, $2, $3, 'CANDIDATE', 'AMOUNT_DATE')`,
            [workspaceA, billPaymentA, successorTransactionA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('enforces intelligence idempotency, series scope, tag scope, and bounded audits', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceA = syntheticIdentitySeed.workspace.id;
      const workspaceB = '20000000-0000-4000-8000-000000000002';
      const connectionA = '40000000-0000-4000-8000-000000000001';
      const connectionB = '40000000-0000-4000-8000-000000000002';
      const accountA = '60000000-0000-4000-8000-000000000001';
      const accountB = '60000000-0000-4000-8000-000000000002';
      const categoryA = '80000000-0000-4000-8000-000000000001';
      const categoryB = '80000000-0000-4000-8000-000000000002';
      const merchantA = '90000000-0000-4000-8000-000000000001';
      const merchantB = '90000000-0000-4000-8000-000000000002';
      const transactionA = 'a0000000-0000-4000-8000-000000000001';
      const transactionB = 'a0000000-0000-4000-8000-000000000002';
      const ruleA = 'b0000000-0000-4000-8000-000000000001';
      const ruleB = 'b0000000-0000-4000-8000-000000000002';
      const installmentA = 'c0000000-0000-4000-8000-000000000001';
      const installmentB = 'c0000000-0000-4000-8000-000000000002';
      const recurringA = 'd0000000-0000-4000-8000-000000000001';
      const tagA = 'e0000000-0000-4000-8000-000000000001';
      const tagB = 'e0000000-0000-4000-8000-000000000002';
      const fingerprint = 'c'.repeat(64);

      try {
        await client.connect();
        await client.query(`insert into workspace (id, name) values ($1, 'Second Workspace')`, [
          workspaceB,
        ]);
        await client.query(
          `insert into provider_connection (id, workspace_id, provider, external_connection_id, external_connector_id, display_name) values ($1, $2, 'PLUGGY', 'item-a', 'connector', 'Connection A'), ($3, $4, 'PLUGGY', 'item-b', 'connector', 'Connection B')`,
          [connectionA, workspaceA, connectionB, workspaceB],
        );
        await client.query(
          `insert into financial_account (id, workspace_id, provider_connection_id, provider, external_account_id, account_type, name, institution_name, currency) values ($1, $2, $3, 'PLUGGY', 'account-a', 'CREDIT_CARD', 'Card A', 'Synthetic Bank', 'BRL'), ($4, $5, $6, 'PLUGGY', 'account-b', 'CREDIT_CARD', 'Card B', 'Synthetic Bank', 'BRL')`,
          [accountA, workspaceA, connectionA, accountB, workspaceB, connectionB],
        );
        await client.query(
          `insert into category (id, workspace_id, code, kind, name_en, name_pt_br) values ($1, $2, 'custom.80000000-0000-4000-8000-000000000001', 'EXPENSE', 'Category A', 'Categoria A'), ($3, $4, 'custom.80000000-0000-4000-8000-000000000002', 'EXPENSE', 'Category B', 'Categoria B')`,
          [categoryA, workspaceA, categoryB, workspaceB],
        );
        await client.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key) values ($1, $2, 'Merchant A', 'merchant-a'), ($3, $4, 'Merchant B', 'merchant-b')`,
          [merchantA, workspaceA, merchantB, workspaceB],
        );
        await insertSyntheticTransaction(client, {
          accountId: accountA,
          id: transactionA,
          providerTransactionId: 'transaction-a',
          workspaceId: workspaceA,
        });
        await insertSyntheticTransaction(client, {
          accountId: accountB,
          id: transactionB,
          providerTransactionId: 'transaction-b',
          workspaceId: workspaceB,
        });

        await client.query(
          `insert into classification_rule (id, workspace_id, name, priority, conditions, actions, source) values ($1, $2, 'Rule A', 10, '{"all":[]}', '{"setFinancialRole":"PURCHASE"}', 'USER'), ($3, $4, 'Rule B', 10, '{"all":[]}', '{"setFinancialRole":"PURCHASE"}', 'USER')`,
          [ruleA, workspaceA, ruleB, workspaceB],
        );
        await client.query(
          `update classification_rule
           set actions = jsonb_build_object('setCategoryCode', $1::text)
           where id = $2`,
          [`custom.${categoryA}`, ruleA],
        );
        await expect(
          client.query(
            `update classification_rule
             set actions = jsonb_build_object('setCategoryCode', $1::text)
             where id = $2`,
            [`custom.${categoryB}`, ruleA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `update classification_rule
             set actions = jsonb_build_object('setCategoryCode', jsonb_build_object('code', $1::text))
             where id = $2`,
            [`custom.${categoryA}`, ruleA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into classification_rule (workspace_id, name, conditions, actions, source) values ($1, 'Invalid JSON Shape', '[]', '{}', 'USER')`,
            [workspaceA],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into classification_rule (workspace_id, name, conditions, actions, source, hit_count) values ($1, 'Invalid Count', '{}', '{}', 'USER', -1)`,
            [workspaceA],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into classification_decision (workspace_id, financial_transaction_id, source, source_reference, classification_rule_id, category_id, merchant_id, financial_role, confidence, input_fingerprint, rationale, selected) values ($1, $2, 'RULE', $3, $4, $5, $6, 'PURCHASE', '0.9900', $7, 'Synthetic deterministic decision', true)`,
          [workspaceA, transactionA, ruleA, ruleA, categoryA, merchantA, fingerprint],
        );
        await expect(
          client.query(
            `insert into classification_decision (workspace_id, financial_transaction_id, source, source_reference, classification_rule_id, input_fingerprint, rationale) values ($1, $2, 'RULE', $3, $4, $5, 'Duplicate')`,
            [workspaceA, transactionA, ruleA, ruleA, fingerprint],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into classification_decision (workspace_id, financial_transaction_id, source, source_reference, classification_rule_id, input_fingerprint, rationale) values ($1, $2, 'RULE', $3, $4, $5, 'Cross transaction')`,
            [workspaceA, transactionB, ruleA, ruleA, 'd'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await expect(
          client.query(
            `insert into classification_decision (workspace_id, financial_transaction_id, source, source_reference, classification_rule_id, input_fingerprint, rationale) values ($1, $2, 'RULE', $3, $4, $5, 'Cross rule')`,
            [workspaceA, transactionA, ruleB, ruleB, 'e'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await expect(
          client.query(
            `insert into classification_decision (workspace_id, financial_transaction_id, source, source_reference, category_id, input_fingerprint, rationale) values ($1, $2, 'PROVIDER', 'PLUGGY', $3, $4, 'Cross category')`,
            [workspaceA, transactionA, categoryB, 'f'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into classification_decision (workspace_id, financial_transaction_id, source, source_reference, input_fingerprint, rationale) values ($1, $2, 'RULE', 'missing-rule', $3, 'Missing rule')`,
            [workspaceA, transactionA, '1'.repeat(64)],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into installment_series (id, workspace_id, financial_account_id, merchant_id, currency, total_installments, highest_confirmed_installment, estimated_installment_amount, original_total_amount, status) values ($1, $2, $3, $4, 'BRL', 12, 3, '100.000000', '1200.000000', 'CONFIRMED'), ($5, $6, $7, $8, 'BRL', 6, 1, '50.000000', '300.000000', 'CONFIRMED')`,
          [
            installmentA,
            workspaceA,
            accountA,
            merchantA,
            installmentB,
            workspaceB,
            accountB,
            merchantB,
          ],
        );
        await expect(
          client.query(
            `insert into installment_series (workspace_id, financial_account_id, currency, total_installments) values ($1, $2, 'BRL', 3)`,
            [workspaceA, accountB],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        await client.query(
          `insert into recurring_series (id, workspace_id, merchant_id, category_id, cadence, expected_interval_days, currency, amount_min, amount_max, amount_average, last_occurrence_date, next_expected_date, confidence, status) values ($1, $2, $3, $4, 'MONTHLY', 30, 'BRL', '90.000000', '110.000000', '100.000000', '2026-08-01', '2026-09-01', '0.9500', 'CONFIRMED')`,
          [recurringA, workspaceA, merchantA, categoryA],
        );
        await expect(
          client.query(
            `insert into recurring_series (workspace_id, merchant_id, category_id, cadence, expected_interval_days, currency, amount_min, amount_max, amount_average, last_occurrence_date, confidence) values ($1, $2, $3, 'MONTHLY', 30, 'BRL', '90', '110', '100', '2026-08-01', '0.9')`,
            [workspaceA, merchantA, categoryB],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into recurring_series (workspace_id, merchant_id, cadence, expected_interval_days, currency, amount_min, amount_max, amount_average, last_occurrence_date, confidence) values ($1, $2, 'MONTHLY', 30, 'BRL', '100', '90', '95', '2026-08-01', '0.9')`,
            [workspaceA, merchantA],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `update financial_transaction set installment_series_id = $1, recurring_series_id = $2 where id = $3`,
          [installmentA, recurringA, transactionA],
        );
        await expect(
          client.query(
            `update financial_transaction set installment_series_id = $1 where id = $2`,
            [installmentB, transactionA],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        await client.query(
          `insert into tag (id, workspace_id, name, normalized_name) values ($1, $2, 'Work', 'work'), ($3, $4, 'Work', 'work')`,
          [tagA, workspaceA, tagB, workspaceB],
        );
        await client.query(
          `insert into transaction_tag (workspace_id, financial_transaction_id, tag_id) values ($1, $2, $3)`,
          [workspaceA, transactionA, tagA],
        );
        await expect(
          client.query(
            `insert into transaction_tag (workspace_id, financial_transaction_id, tag_id) values ($1, $2, $3)`,
            [workspaceA, transactionA, tagA],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into transaction_tag (workspace_id, financial_transaction_id, tag_id) values ($1, $2, $3)`,
            [workspaceA, transactionA, tagB],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        await client.query(
          `insert into audit_event (actor_type, event_type, details) values ('SYSTEM', 'SECRET_ROTATION_MARKER', '{"result":"synthetic-success"}')`,
        );
        await expect(
          client.query(
            `insert into audit_event (workspace_id, actor_type, event_type) values ('30000000-0000-4000-8000-000000000001', 'SYSTEM', 'INVALID_WORKSPACE')`,
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await expect(
          client.query(
            `insert into audit_event (actor_type, event_type, details) values ('SYSTEM', 'INVALID_DETAILS', '[]')`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('applies effective overrides and exposes currency-safe financial views', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceId = syntheticIdentitySeed.workspace.id;
      const connectionId = '40000000-0000-4000-8000-000000000010';
      const checkingAccountId = '50000000-0000-4000-8000-000000000010';
      const cardAccountId = '50000000-0000-4000-8000-000000000011';
      const categoryId = '80000000-0000-4000-8000-000000000010';
      const merchantId = '90000000-0000-4000-8000-000000000010';
      const purchaseId = 'a0000000-0000-4000-8000-000000000010';
      const refundId = 'a0000000-0000-4000-8000-000000000011';
      const billPurchaseId = 'a0000000-0000-4000-8000-000000000012';
      const billPaymentId = 'a0000000-0000-4000-8000-000000000013';
      const mixedCurrencyId = 'a0000000-0000-4000-8000-000000000014';
      const billId = '60000000-0000-4000-8000-000000000010';
      const paymentEvidenceId = '61000000-0000-4000-8000-000000000010';
      const installmentSeriesId = '62000000-0000-4000-8000-000000000010';

      try {
        await client.connect();
        await client.query(
          `insert into provider_connection (
            id, workspace_id, provider, external_connection_id, external_connector_id,
            display_name, last_successful_sync_at
          ) values ($1, $2, 'PLUGGY', 'views-item', 'views-connector', 'Views Connection', now())`,
          [connectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
            id, workspace_id, provider_connection_id, provider, external_account_id,
            account_type, name, institution_name, currency, last_successful_sync_at,
            provider_history_earliest_date, provider_history_latest_date,
            initial_import_completed_at, history_coverage_status
          ) values
            ($1, $2, $3, 'PLUGGY', 'views-checking', 'CHECKING', 'Checking',
              'Synthetic Bank', 'BRL', now(), '2026-01-01', '2026-08-20', now(),
              'PROVIDER_MAXIMUM_RETRIEVED'),
            ($4, $2, $3, 'PLUGGY', 'views-card', 'CREDIT_CARD', 'Card',
              'Synthetic Bank', 'BRL', now(), '2026-01-01', '2026-08-20', now(),
              'PROVIDER_MAXIMUM_RETRIEVED')`,
          [checkingAccountId, workspaceId, connectionId, cardAccountId],
        );
        await client.query(
          `insert into category (id, workspace_id, code, kind, name_en, name_pt_br)
           values ($1, $2, 'custom.80000000-0000-4000-8000-000000000010',
             'EXPENSE', 'Views Category', 'Categoria de Views')`,
          [categoryId, workspaceId],
        );
        await client.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key)
           values ($1, $2, 'Views Merchant', 'views-merchant')`,
          [merchantId, workspaceId],
        );
        await client.query(
          `insert into credit_card_bill (
            id, workspace_id, financial_account_id, provider, external_bill_id,
            status, total_amount, currency
          ) values ($1, $2, $3, 'PLUGGY', 'views-bill', 'CLOSED', '100.000000', 'BRL')`,
          [billId, workspaceId, cardAccountId],
        );

        await insertSyntheticTransaction(client, {
          accountId: checkingAccountId,
          categoryId,
          id: purchaseId,
          merchantId,
          providerTransactionId: 'views-purchase',
          workspaceId,
        });
        await insertSyntheticTransaction(client, {
          accountId: cardAccountId,
          categoryId,
          id: refundId,
          providerTransactionId: 'views-refund',
          workspaceId,
        });
        await insertSyntheticTransaction(client, {
          accountId: cardAccountId,
          billId,
          categoryId,
          id: billPurchaseId,
          merchantId,
          providerTransactionId: 'views-bill-purchase',
          workspaceId,
        });
        await insertSyntheticTransaction(client, {
          accountId: checkingAccountId,
          id: billPaymentId,
          providerTransactionId: 'views-bill-payment',
          workspaceId,
        });
        await insertSyntheticTransaction(client, {
          accountId: cardAccountId,
          categoryId,
          id: mixedCurrencyId,
          merchantId,
          providerTransactionId: 'views-mixed-currency',
          workspaceId,
        });

        await client.query(
          `update financial_transaction
           set provider_amount_signed = case id
             when $1 then '-100.000000'::numeric
             when $2 then '-20.000000'::numeric
             when $3 then '100.000000'::numeric
             when $4 then '-500.000000'::numeric
             else '30.000000'::numeric
           end,
           provider_currency = case when id = $5 then 'USD' else 'BRL' end,
           system_direction = case
             when id = $2 then 'INFLOW'
             when id = $5 then 'OUTFLOW'
             else 'OUTFLOW'
           end,
           system_financial_role = case
             when id = $2 then 'REFUND'
             when id = $4 then 'CARD_BILL_PAYMENT'
             else 'PURCHASE'
           end,
           system_is_excluded_from_spend = (id = $4),
           system_category_source = case when system_category_id is null then 'NONE' else 'RULE' end,
           system_merchant_source = case when system_merchant_id is null then 'NONE' else 'MERCHANT' end,
           system_financial_role_source = 'HEURISTIC',
           system_exclusion_source = 'HEURISTIC'
           where id in ($1, $2, $3, $4, $5)`,
          [purchaseId, refundId, billPurchaseId, billPaymentId, mixedCurrencyId],
        );
        await client.query(
          `insert into transaction_user_state (
            financial_transaction_id, workspace_id, category_override_enabled,
            financial_role_override_enabled, financial_role_override, review_status,
            updated_by_actor_type
          ) values ($1, $2, true, true, 'REFUND', 'NEEDS_REVIEW', 'USER')`,
          [refundId, workspaceId],
        );
        await client.query(
          `insert into installment_series (
            id, workspace_id, financial_account_id, merchant_id, currency,
            total_installments, highest_confirmed_installment,
            estimated_installment_amount, original_total_amount, status
          ) values ($1, $2, $3, $4, 'BRL', 3, 1, '100.000000', '300.000000', 'CONFIRMED')`,
          [installmentSeriesId, workspaceId, cardAccountId, merchantId],
        );
        await client.query(
          'update financial_transaction set installment_series_id = $1 where id = $2',
          [installmentSeriesId, billPurchaseId],
        );
        await client.query(
          `insert into credit_card_bill_payment (
            id, workspace_id, credit_card_bill_id, provider, external_payment_id,
            value_type, payment_date, amount, currency
          ) values ($1, $2, $3, 'PLUGGY', 'views-payment', 'PAID', '2026-08-20',
            '500.000000', 'BRL')`,
          [paymentEvidenceId, workspaceId, billId],
        );
        await client.query(
          `insert into credit_card_bill_finance_charge (
            workspace_id, credit_card_bill_id, provider, external_charge_id,
            charge_type, amount, currency
          ) values ($1, $2, 'PLUGGY', 'views-charge', 'INTEREST', '5.000000', 'BRL')`,
          [workspaceId, billId],
        );
        await client.query(
          `insert into bill_payment_reconciliation (
            workspace_id, credit_card_bill_payment_id, financial_transaction_id,
            match_status, match_method, confidence, matched_at
          ) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
          [workspaceId, paymentEvidenceId, billPaymentId],
        );
        await client.query(
          `insert into transaction_identity_link (
            workspace_id, predecessor_transaction_id, successor_transaction_id,
            status, confidence
          ) values ($1, $2, $3, 'NEEDS_REVIEW', '0.8000')`,
          [workspaceId, purchaseId, refundId],
        );

        const effectiveRefund = await client.query<{
          analytics_amount_signed: string;
          effective_category_id: string | null;
          effective_category_source: string;
          effective_financial_role: string;
        }>(
          `select analytics_amount_signed, effective_category_id,
             effective_category_source, effective_financial_role
           from v_financial_transaction_effective where id = $1`,
          [refundId],
        );
        expect(effectiveRefund.rows[0]).toEqual({
          analytics_amount_signed: '-20.000000',
          effective_category_id: null,
          effective_category_source: 'USER',
          effective_financial_role: 'REFUND',
        });

        const effects = await client.query<{
          cashflow_effect_amount: string | null;
          id: string;
          spend_effect_amount: string | null;
        }>(
          `select s.id, s.spend_effect_amount, c.cashflow_effect_amount
           from v_transaction_spend_effect s
           join v_transaction_cashflow_effect c on c.workspace_id = s.workspace_id and c.id = s.id
           order by s.id`,
        );
        expect(
          Object.fromEntries(
            effects.rows.map((row) => [
              row.id,
              [row.spend_effect_amount, row.cashflow_effect_amount],
            ]),
          ),
        ).toEqual({
          [purchaseId]: ['100.000000', '-100.000000'],
          [refundId]: ['-20.000000', '0.000000'],
          [billPurchaseId]: ['100.000000', '0.000000'],
          [billPaymentId]: ['0.000000', '-500.000000'],
          [mixedCurrencyId]: [null, '0.000000'],
        });

        const categorySummary = await client.query<{
          spend_amount: string;
          transaction_count: string;
          unconverted_transaction_count: string;
        }>(
          `select spend_amount, transaction_count, unconverted_transaction_count
           from v_monthly_spend_by_category
           where workspace_id = $1 and category_id = $2`,
          [workspaceId, categoryId],
        );
        expect(categorySummary.rows[0]).toEqual({
          spend_amount: '200.000000',
          transaction_count: '2',
          unconverted_transaction_count: '1',
        });

        const bill = await client.query<{
          confirmed_bank_payment_total: string;
          difference_amount: string;
          reconciliation_status: string;
          unresolved_item_count: string;
        }>(
          `select confirmed_bank_payment_total, difference_amount,
             reconciliation_status, unresolved_item_count
           from v_credit_card_bill_reconciliation where credit_card_bill_id = $1`,
          [billId],
        );
        expect(bill.rows[0]).toEqual({
          confirmed_bank_payment_total: '500.000000',
          difference_amount: '0.000000',
          reconciliation_status: 'NEEDS_REVIEW',
          unresolved_item_count: '1',
        });

        const installment = await client.query<{
          estimated_remaining_commitment: string;
          posted_amount: string;
          remaining_installments: number;
        }>(
          `select estimated_remaining_commitment, posted_amount, remaining_installments
           from v_installment_commitments where installment_series_id = $1`,
          [installmentSeriesId],
        );
        expect(installment.rows[0]).toEqual({
          estimated_remaining_commitment: '200.000000',
          posted_amount: '100.000000',
          remaining_installments: 2,
        });

        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from v_unclassified_transactions where id = '${refundId}'`,
          ),
        ).toBe(1);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from v_transactions_needing_review where id = '${refundId}'`,
          ),
        ).toBe(1);
        expect(
          await queryCount(
            client,
            'select count(*)::integer as count from v_transaction_replacement_review',
          ),
        ).toBe(1);
        expect(
          await queryCount(
            client,
            'select count(*)::integer as count from v_account_history_coverage',
          ),
        ).toBe(2);
        expect(
          await queryCount(
            client,
            'select count(*)::integer as count from v_account_data_freshness where not is_stale',
          ),
        ).toBe(2);
        expect(
          await queryCount(
            client,
            `select count(*)::integer as count from v_monthly_spend_by_merchant where merchant_id = '${merchantId}'`,
          ),
        ).toBe(1);
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('validates bill children and active payment reconciliation evidence', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const workspaceId = syntheticIdentitySeed.workspace.id;
      const connectionId = '40000000-0000-4000-8000-000000000030';
      const brlCheckingId = '50000000-0000-4000-8000-000000000030';
      const brlCardId = '50000000-0000-4000-8000-000000000031';
      const usdCheckingId = '50000000-0000-4000-8000-000000000032';
      const usdCardId = '50000000-0000-4000-8000-000000000033';
      const brlBillId = '60000000-0000-4000-8000-000000000030';
      const usdBillId = '60000000-0000-4000-8000-000000000031';
      const brlPaymentA = '61000000-0000-4000-8000-000000000030';
      const brlPaymentB = '61000000-0000-4000-8000-000000000031';
      const usdPayment = '61000000-0000-4000-8000-000000000032';
      const withinToleranceId = 'a0000000-0000-4000-8000-000000000030';
      const outsideToleranceId = 'a0000000-0000-4000-8000-000000000031';
      const outsideDateId = 'a0000000-0000-4000-8000-000000000032';
      const usdTransactionId = 'a0000000-0000-4000-8000-000000000033';

      try {
        await client.connect();
        await client.query(
          `insert into provider_connection (
            id, workspace_id, provider, external_connection_id, external_connector_id, display_name
          ) values ($1, $2, 'PLUGGY', 'reconciliation-item', 'reconciliation-connector',
            'Reconciliation Connection')`,
          [connectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
            id, workspace_id, provider_connection_id, provider, external_account_id,
            account_type, name, institution_name, currency
          ) values
            ($1, $2, $3, 'PLUGGY', 'reconciliation-brl-checking', 'CHECKING',
              'BRL Checking', 'Synthetic Bank', 'BRL'),
            ($4, $2, $3, 'PLUGGY', 'reconciliation-brl-card', 'CREDIT_CARD',
              'BRL Card', 'Synthetic Bank', 'BRL'),
            ($5, $2, $3, 'PLUGGY', 'reconciliation-usd-checking', 'CHECKING',
              'USD Checking', 'Synthetic Bank', 'USD'),
            ($6, $2, $3, 'PLUGGY', 'reconciliation-usd-card', 'CREDIT_CARD',
              'USD Card', 'Synthetic Bank', 'USD')`,
          [brlCheckingId, workspaceId, connectionId, brlCardId, usdCheckingId, usdCardId],
        );
        await client.query(
          `insert into credit_card_bill (
            id, workspace_id, financial_account_id, provider, external_bill_id,
            status, total_amount, currency
          ) values
            ($1, $2, $3, 'PLUGGY', 'reconciliation-brl-bill', 'CLOSED', '0', 'BRL'),
            ($4, $2, $5, 'PLUGGY', 'reconciliation-usd-bill', 'CLOSED', '0', 'USD')`,
          [brlBillId, workspaceId, brlCardId, usdBillId, usdCardId],
        );
        await client.query(
          `insert into credit_card_bill_payment (
            id, workspace_id, credit_card_bill_id, provider, external_payment_id,
            value_type, payment_date, amount, currency
          ) values
            ($1, $2, $3, 'PLUGGY', 'reconciliation-payment-a', 'PAID',
              '2026-08-20', '100.000000', 'BRL'),
            ($4, $2, $3, 'PLUGGY', 'reconciliation-payment-b', 'PAID',
              '2026-08-20', '100.000000', 'BRL'),
            ($5, $2, $6, 'PLUGGY', 'reconciliation-payment-usd', 'PAID',
              '2026-08-20', '100.000000', 'USD')`,
          [brlPaymentA, workspaceId, brlBillId, brlPaymentB, usdPayment, usdBillId],
        );
        await expect(
          client.query(
            `insert into credit_card_bill_payment (
              workspace_id, credit_card_bill_id, provider, external_payment_id,
              value_type, payment_date, amount, currency
            ) values ($1, $2, 'PLUGGY', 'wrong-currency', 'PAID',
              '2026-08-20', '100.000000', 'USD')`,
            [workspaceId, brlBillId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into credit_card_bill_finance_charge (
              workspace_id, credit_card_bill_id, provider, external_charge_id,
              charge_type, amount, currency
            ) values ($1, $2, 'PLUGGY', 'wrong-currency-charge', 'INTEREST',
              '1.000000', 'USD')`,
            [workspaceId, brlBillId],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        for (const [id, accountId, providerTransactionId] of [
          [withinToleranceId, brlCheckingId, 'within-tolerance'],
          [outsideToleranceId, brlCheckingId, 'outside-tolerance'],
          [outsideDateId, brlCheckingId, 'outside-date'],
          [usdTransactionId, usdCheckingId, 'usd-payment'],
        ] as const) {
          await insertSyntheticTransaction(client, {
            accountId,
            id,
            providerTransactionId,
            workspaceId,
          });
        }
        await client.query(
          `update financial_transaction
           set provider_amount_signed = case id
                 when $1 then '-100.009000'::numeric
                 when $2 then '-100.011000'::numeric
                 else '-100.000000'::numeric
               end,
               provider_currency = case when id = $4 then 'USD' else 'BRL' end,
               account_currency = case when id = $4 then 'USD' else 'BRL' end,
               transaction_local_date = case when id = $3 then '2026-08-23'::date
                 else '2026-08-20'::date end,
               system_financial_role = 'CARD_BILL_PAYMENT',
               system_financial_role_source = 'HEURISTIC',
               system_is_excluded_from_spend = true,
               system_exclusion_source = 'HEURISTIC'
           where id in ($1, $2, $3, $4)`,
          [withinToleranceId, outsideToleranceId, outsideDateId, usdTransactionId],
        );

        await client.query(
          `insert into bill_payment_reconciliation (
            workspace_id, credit_card_bill_payment_id, financial_transaction_id,
            match_status, match_method, confidence, matched_at
          ) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
          [workspaceId, brlPaymentA, withinToleranceId],
        );
        await expect(
          client.query(
            `insert into bill_payment_reconciliation (
              workspace_id, credit_card_bill_payment_id, financial_transaction_id,
              match_status, match_method, confidence, matched_at
            ) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
            [workspaceId, brlPaymentB, withinToleranceId],
          ),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          client.query(
            `insert into bill_payment_reconciliation (
              workspace_id, credit_card_bill_payment_id, financial_transaction_id,
              match_status, match_method, confidence, matched_at
            ) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
            [workspaceId, brlPaymentB, outsideToleranceId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into bill_payment_reconciliation (
              workspace_id, credit_card_bill_payment_id, financial_transaction_id,
              match_status, match_method, confidence, matched_at
            ) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
            [workspaceId, brlPaymentB, outsideDateId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          client.query(
            `insert into bill_payment_reconciliation (
              workspace_id, credit_card_bill_payment_id, financial_transaction_id,
              match_status, match_method, confidence, matched_at
            ) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
            [workspaceId, usdPayment, usdTransactionId],
          ),
        ).rejects.toMatchObject({ code: '23514' });

        await client.query(
          `insert into reconciliation_currency_tolerance (currency, tolerance_amount)
           values ('USD', '0.000000')`,
        );
        await client.query(
          `insert into bill_payment_reconciliation (
            workspace_id, credit_card_bill_payment_id, financial_transaction_id,
            match_status, match_method, confidence, matched_at
          ) values ($1, $2, $3, 'AUTO_MATCHED', 'AMOUNT_DATE', '0.9900', now())`,
          [workspaceId, usdPayment, usdTransactionId],
        );
        await client.query(
          `update financial_transaction set transaction_local_date = '2026-08-20' where id = $1`,
          [outsideDateId],
        );
        await expect(
          client.query(
            `insert into bill_payment_reconciliation (
              workspace_id, credit_card_bill_payment_id, financial_transaction_id,
              match_status, match_method, matched_at
            ) values ($1, $2, $3, 'USER_CONFIRMED', 'USER', now())`,
            [workspaceId, brlPaymentB, outsideDateId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await client.query(
          `insert into bill_payment_reconciliation (
            workspace_id, credit_card_bill_payment_id, financial_transaction_id,
            match_status, match_method, matched_at, confirmed_by
          ) values ($1, $2, $3, 'USER_CONFIRMED', 'USER', now(), 'synthetic-owner')`,
          [workspaceId, brlPaymentB, outsideDateId],
        );

        const brlSummary = await client.query<{
          confirmed_bank_payment_total: string;
          confirmed_bank_payment_count: string;
          tolerance_amount: string;
          unresolved_item_count: string;
        }>(
          `select confirmed_bank_payment_total, confirmed_bank_payment_count,
             tolerance_amount, unresolved_item_count
           from v_credit_card_bill_reconciliation where credit_card_bill_id = $1`,
          [brlBillId],
        );
        expect(brlSummary.rows[0]).toEqual({
          confirmed_bank_payment_total: '200.009000',
          confirmed_bank_payment_count: '2',
          tolerance_amount: '0.010000',
          unresolved_item_count: '0',
        });
        expect(
          await queryCount(
            client,
            "select count(*)::integer as count from reconciliation_currency_tolerance where currency in ('BRL', 'USD')",
          ),
        ).toBe(2);
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it('updates transaction user state with explicit overrides and optimistic concurrency', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);
      await seedSyntheticIdentity(connectionString, 'test');

      const client = new Client({ connectionString });
      const pool = new Pool({ connectionString });
      const repository = new TransactionUserStateRepository(pool);
      const workspaceId = syntheticIdentitySeed.workspace.id;
      const wrongWorkspaceId = '20000000-0000-4000-8000-000000000099';
      const connectionId = '40000000-0000-4000-8000-000000000020';
      const accountId = '50000000-0000-4000-8000-000000000020';
      const categoryId = '80000000-0000-4000-8000-000000000020';
      const merchantId = '90000000-0000-4000-8000-000000000020';
      const transactionId = 'a0000000-0000-4000-8000-000000000020';

      try {
        await client.connect();
        await client.query(
          `insert into provider_connection (
            id, workspace_id, provider, external_connection_id, external_connector_id, display_name
          ) values ($1, $2, 'PLUGGY', 'user-state-item', 'user-state-connector',
            'User State Connection')`,
          [connectionId, workspaceId],
        );
        await client.query(
          `insert into financial_account (
            id, workspace_id, provider_connection_id, provider, external_account_id,
            account_type, name, institution_name, currency
          ) values ($1, $2, $3, 'PLUGGY', 'user-state-account', 'CHECKING',
            'User State Account', 'Synthetic Bank', 'BRL')`,
          [accountId, workspaceId, connectionId],
        );
        await client.query(
          `insert into category (id, workspace_id, code, kind, name_en, name_pt_br)
           values ($1, $2, 'custom.80000000-0000-4000-8000-000000000020',
             'EXPENSE', 'System Category', 'Categoria do Sistema')`,
          [categoryId, workspaceId],
        );
        await client.query(
          `insert into merchant (id, workspace_id, canonical_name, normalized_key)
           values ($1, $2, 'System Merchant', 'system-merchant')`,
          [merchantId, workspaceId],
        );
        await insertSyntheticTransaction(client, {
          accountId,
          categoryId,
          id: transactionId,
          merchantId,
          providerTransactionId: 'user-state-transaction',
          workspaceId,
        });
        await client.query(
          `update financial_transaction
           set system_category_source = 'RULE',
               system_merchant_source = 'MERCHANT',
               system_financial_role_source = 'HEURISTIC',
               system_exclusion_source = 'HEURISTIC'
           where id = $1`,
          [transactionId],
        );

        expect(await repository.get(workspaceId, transactionId)).toBeNull();
        expect(await repository.getEffective(workspaceId, transactionId)).toMatchObject({
          categoryOverrideEnabled: false,
          effectiveCategoryId: categoryId,
          effectiveCategorySource: 'RULE',
          effectiveFinancialRole: 'PURCHASE',
          effectiveMerchantId: merchantId,
          userStateVersion: 0,
        });

        const concurrentWrites = await Promise.allSettled([
          repository.update({
            actorType: 'USER',
            expectedVersion: 0,
            notes: 'First concurrent edit',
            transactionId,
            workspaceId,
          }),
          repository.update({
            actorType: 'USER',
            expectedVersion: 0,
            notes: 'Second concurrent edit',
            transactionId,
            workspaceId,
          }),
        ]);
        expect(concurrentWrites.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        const rejectedWrite = concurrentWrites.find(({ status }) => status === 'rejected');
        expect(rejectedWrite).toMatchObject({
          reason: expect.any(TransactionUserStateConflictError),
          status: 'rejected',
        });

        const overridden = await repository.update({
          actorId: 'synthetic-owner',
          actorType: 'USER',
          categoryOverride: { mode: 'CLEAR' },
          excludedFromSpendOverride: { mode: 'SET', value: false },
          expectedVersion: 1,
          financialRoleOverride: { mode: 'SET', value: 'REFUND' },
          merchantOverride: { mode: 'SET', value: merchantId },
          notes: 'Personal note',
          reviewStatus: 'CONFIRMED',
          transactionId,
          workspaceId,
        });
        expect(overridden).toMatchObject({
          categoryIdOverride: null,
          categoryOverrideEnabled: true,
          excludedFromSpendOverride: false,
          financialRoleOverride: 'REFUND',
          financialRoleOverrideEnabled: true,
          merchantIdOverride: merchantId,
          merchantOverrideEnabled: true,
          notes: 'Personal note',
          reviewStatus: 'CONFIRMED',
          version: 2,
        });
        expect(await repository.getEffective(workspaceId, transactionId)).toMatchObject({
          effectiveCategoryId: null,
          effectiveCategorySource: 'USER',
          effectiveExclusionSource: 'USER',
          effectiveFinancialRole: 'REFUND',
          effectiveFinancialRoleSource: 'USER',
          effectiveIsExcludedFromSpend: false,
          effectiveMerchantId: merchantId,
          effectiveMerchantSource: 'USER',
          notes: 'Personal note',
          reviewStatus: 'CONFIRMED',
          userStateVersion: 2,
        });

        const inherited = await repository.update({
          actorType: 'USER',
          categoryOverride: { mode: 'INHERIT' },
          excludedFromSpendOverride: { mode: 'INHERIT' },
          expectedVersion: 2,
          financialRoleOverride: { mode: 'INHERIT' },
          merchantOverride: { mode: 'INHERIT' },
          notes: null,
          reviewStatus: 'UNREVIEWED',
          transactionId,
          workspaceId,
        });
        expect(inherited).toMatchObject({
          categoryOverrideEnabled: false,
          excludedFromSpendOverride: null,
          financialRoleOverrideEnabled: false,
          merchantOverrideEnabled: false,
          notes: null,
          version: 3,
        });
        expect(await repository.getEffective(workspaceId, transactionId)).toMatchObject({
          effectiveCategoryId: categoryId,
          effectiveCategorySource: 'RULE',
          effectiveExclusionSource: 'HEURISTIC',
          effectiveFinancialRole: 'PURCHASE',
          effectiveFinancialRoleSource: 'HEURISTIC',
          effectiveMerchantId: merchantId,
          effectiveMerchantSource: 'MERCHANT',
          userStateVersion: 3,
        });

        await expect(
          repository.update({
            actorType: 'USER',
            expectedVersion: 2,
            notes: 'Stale edit',
            transactionId,
            workspaceId,
          }),
        ).rejects.toMatchObject({
          actualVersion: 3,
          expectedVersion: 2,
          name: 'TransactionUserStateConflictError',
        });
        expect(await repository.getEffective(wrongWorkspaceId, transactionId)).toBeNull();
        await expect(
          repository.update({
            actorType: 'USER',
            expectedVersion: 3,
            transactionId,
            workspaceId: wrongWorkspaceId,
          }),
        ).rejects.toBeInstanceOf(TransactionNotFoundError);

        await client.query(
          `update financial_transaction
           set system_financial_role = 'FEE', system_financial_role_source = 'RULE'
           where workspace_id = $1 and id = $2`,
          [workspaceId, transactionId],
        );
        expect(await repository.get(workspaceId, transactionId)).toMatchObject({ version: 3 });
        expect(await repository.getEffective(workspaceId, transactionId)).toMatchObject({
          effectiveFinancialRole: 'FEE',
          effectiveFinancialRoleSource: 'RULE',
          userStateVersion: 3,
        });
      } finally {
        await pool.end();
        await client.end();
      }
    });
  }, 30_000);

  it('audits composite workspace foreign keys, candidate keys, and category guards', async () => {
    await withTemporaryDatabase(async (connectionString) => {
      await runMigrations(connectionString);

      const client = new Client({ connectionString });

      try {
        await client.connect();
        const workspaceForeignKeys = await client.query<WorkspaceForeignKeyAuditRow>(
          `select
             con.conname as constraint_name,
             child.relname as child_table,
             parent.relname as parent_table,
             array(
               select child_attribute.attname
               from unnest(con.conkey) with ordinality key_column(attnum, ordinal)
               join pg_attribute child_attribute
                 on child_attribute.attrelid = con.conrelid
                and child_attribute.attnum = key_column.attnum
               order by key_column.ordinal
             )::text[] as child_columns,
             array(
               select parent_attribute.attname
               from unnest(con.confkey) with ordinality key_column(attnum, ordinal)
               join pg_attribute parent_attribute
                 on parent_attribute.attrelid = con.confrelid
                and parent_attribute.attnum = key_column.attnum
               order by key_column.ordinal
             )::text[] as parent_columns,
             exists (
               select 1
               from pg_constraint candidate
               where candidate.conrelid = con.confrelid
                 and candidate.contype in ('p', 'u')
                 and array(
                   select candidate_attribute.attname
                   from unnest(candidate.conkey) with ordinality candidate_column(attnum, ordinal)
                   join pg_attribute candidate_attribute
                     on candidate_attribute.attrelid = candidate.conrelid
                    and candidate_attribute.attnum = candidate_column.attnum
                   order by candidate_column.ordinal
                 ) = array['workspace_id', 'id']::name[]
             ) as parent_has_workspace_candidate_key
           from pg_constraint con
           join pg_class child on child.oid = con.conrelid
           join pg_namespace child_namespace on child_namespace.oid = child.relnamespace
           join pg_class parent on parent.oid = con.confrelid
           join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
           where con.contype = 'f'
             and child_namespace.nspname = 'public'
             and parent_namespace.nspname = 'public'
             and parent.relname not in ('workspace', 'category')
             and exists (
               select 1 from pg_attribute
               where attrelid = child.oid and attname = 'workspace_id' and not attisdropped
             )
             and exists (
               select 1 from pg_attribute
               where attrelid = parent.oid and attname = 'workspace_id' and not attisdropped
             )
           order by child.relname, con.conname`,
        );

        expect(workspaceForeignKeys.rows).toHaveLength(34);
        for (const foreignKey of workspaceForeignKeys.rows) {
          expect(foreignKey.child_columns[0], foreignKey.constraint_name).toBe('workspace_id');
          expect(foreignKey.parent_columns[0], foreignKey.constraint_name).toBe('workspace_id');
          expect(foreignKey.parent_has_workspace_candidate_key, foreignKey.parent_table).toBe(true);
        }

        const categoryTriggers = await client.query<{ trigger_name: string }>(
          `select distinct trigger_name
           from information_schema.triggers
           where trigger_schema = 'public'
             and trigger_name in (
               'category_scope_validate_trg',
               'merchant_category_visibility_trg',
               'financial_transaction_category_visibility_trg',
               'transaction_user_state_category_visibility_trg',
               'recurring_series_category_visibility_trg',
               'classification_decision_category_visibility_trg',
               'classification_rule_category_action_visibility_trg'
             )
           order by trigger_name`,
        );
        expect(categoryTriggers.rows.map(({ trigger_name }) => trigger_name)).toEqual([
          'category_scope_validate_trg',
          'classification_decision_category_visibility_trg',
          'classification_rule_category_action_visibility_trg',
          'financial_transaction_category_visibility_trg',
          'merchant_category_visibility_trg',
          'recurring_series_category_visibility_trg',
          'transaction_user_state_category_visibility_trg',
        ]);
      } finally {
        await client.end();
      }
    });
  }, 30_000);

  it.each([
    { entryCount: 1, expectedTables: 0, ticket: 'PF-011' },
    { entryCount: 2, expectedTables: 3, ticket: 'PF-012' },
    { entryCount: 3, expectedTables: 8, ticket: 'PF-013' },
    { entryCount: 4, expectedTables: 20, ticket: 'PF-014' },
    { entryCount: 5, expectedTables: 27, ticket: 'PF-015' },
    { entryCount: 6, expectedTables: 27, ticket: 'PF-016' },
    { entryCount: 7, expectedTables: 27, ticket: 'PF-017' },
    { entryCount: 8, expectedTables: 28, ticket: 'PF-019' },
  ])(
    'upgrades a $ticket database without reapplying prior migrations',
    async ({ entryCount, expectedTables }) => {
      const partialMigrationsFolder = await createPartialMigrationFolder(entryCount);

      try {
        await withTemporaryDatabase(async (connectionString) => {
          await runMigrations(connectionString, partialMigrationsFolder);

          const beforeUpgradeClient = new Client({ connectionString });

          try {
            await beforeUpgradeClient.connect();
            expect(
              await queryCount(
                beforeUpgradeClient,
                'select count(*)::integer as count from drizzle.__drizzle_migrations',
              ),
            ).toBe(entryCount);
            expect(
              await queryCount(
                beforeUpgradeClient,
                "select count(*)::integer as count from pg_tables where schemaname = 'public'",
              ),
            ).toBe(expectedTables);
          } finally {
            await beforeUpgradeClient.end();
          }

          await runMigrations(connectionString);

          const afterUpgradeClient = new Client({ connectionString });

          try {
            await afterUpgradeClient.connect();
            expect(
              await queryCount(
                afterUpgradeClient,
                'select count(*)::integer as count from drizzle.__drizzle_migrations',
              ),
            ).toBe(9);
            expect(
              await queryCount(
                afterUpgradeClient,
                "select count(*)::integer as count from pg_tables where schemaname = 'public'",
              ),
            ).toBe(29);
            expect(
              await queryCount(
                afterUpgradeClient,
                "select count(*)::integer as count from information_schema.views where table_schema = 'public' and table_name like 'v_%'",
              ),
            ).toBe(12);
          } finally {
            await afterUpgradeClient.end();
          }
        });
      } finally {
        await rm(partialMigrationsFolder, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
