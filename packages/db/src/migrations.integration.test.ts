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
        ).toBe(3);
        expect(
          await queryCount(
            client,
            "select count(*)::integer as count from pg_tables where schemaname = 'public'",
          ),
        ).toBe(8);
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

  it.each([
    { entryCount: 1, expectedTables: 0, ticket: 'PF-011' },
    { entryCount: 2, expectedTables: 3, ticket: 'PF-012' },
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
            ).toBe(3);
            expect(
              await queryCount(
                afterUpgradeClient,
                "select count(*)::integer as count from pg_tables where schemaname = 'public'",
              ),
            ).toBe(8);
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
