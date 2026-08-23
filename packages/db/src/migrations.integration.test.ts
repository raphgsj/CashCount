import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseDatabaseConfig } from '@cashcount/config';
import { Client } from 'pg';
import { describe, expect, it } from 'vitest';

import { defaultMigrationsFolder, runMigrations } from './migrations.js';
import { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';

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
        ).toBe(7);
        expect(
          await queryCount(
            client,
            "select count(*)::integer as count from pg_tables where schemaname = 'public'",
          ),
        ).toBe(27);
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
      const envelopeSql = "decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex')";

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
      const envelopeSql = "decode('01', 'hex'), decode('02', 'hex'), decode('03', 'hex')";

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
            `insert into bill_payment_reconciliation (workspace_id, credit_card_bill_payment_id, financial_transaction_id, match_status, match_method, matched_at) values ($1, $2, $3, 'USER_CONFIRMED', 'USER', now())`,
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
            ).toBe(7);
            expect(
              await queryCount(
                afterUpgradeClient,
                "select count(*)::integer as count from pg_tables where schemaname = 'public'",
              ),
            ).toBe(27);
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
