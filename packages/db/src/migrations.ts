import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

export const defaultMigrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

export async function runMigrations(
  connectionString: string,
  migrationsFolder = defaultMigrationsFolder,
): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });

  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
