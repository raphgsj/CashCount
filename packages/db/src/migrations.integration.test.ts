import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './migrations.js';

interface CountResult {
  count: number;
}

function quoteIdentifier(identifier: string): string {
  if (!/^cashcount_migration_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected test database identifier.');
  }

  return `"${identifier}"`;
}

describe('database migrations', () => {
  it('runs from an empty PostgreSQL database and remains idempotent', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_migration_${randomUUID().replaceAll('-', '')}`;
    const quotedDatabaseName = quoteIdentifier(databaseName);
    const migratedDatabaseUrl = new URL(databaseUrl);
    const adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    let databaseCreated = false;

    migratedDatabaseUrl.pathname = `/${databaseName}`;

    try {
      await adminPool.query(`CREATE DATABASE ${quotedDatabaseName} TEMPLATE template0`);
      databaseCreated = true;

      await runMigrations(migratedDatabaseUrl.toString());
      await runMigrations(migratedDatabaseUrl.toString());

      const verificationPool = new Pool({
        connectionString: migratedDatabaseUrl.toString(),
        max: 1,
      });

      try {
        const migrationCount = await verificationPool.query<CountResult>(
          'select count(*)::integer as count from drizzle.__drizzle_migrations',
        );
        const applicationTableCount = await verificationPool.query<CountResult>(
          "select count(*)::integer as count from pg_tables where schemaname = 'public'",
        );

        expect(migrationCount.rows[0]?.count).toBe(1);
        expect(applicationTableCount.rows[0]?.count).toBe(0);
      } finally {
        await verificationPool.end();
      }
    } finally {
      if (databaseCreated) {
        await adminPool.query(`DROP DATABASE ${quotedDatabaseName} WITH (FORCE)`);
      }

      await adminPool.end();
    }
  }, 30_000);
});
