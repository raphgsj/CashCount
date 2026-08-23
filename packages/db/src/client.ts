import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export interface DatabaseClient {
  database: NodePgDatabase;
  pool: Pool;
}

export function createDatabaseClient(connectionString: string): DatabaseClient {
  const pool = new Pool({ connectionString });

  return {
    database: drizzle({ client: pool }),
    pool,
  };
}
