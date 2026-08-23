import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema.js';

export interface DatabaseClient {
  database: NodePgDatabase<typeof schema>;
  pool: Pool;
}

export function createDatabaseClient(connectionString: string): DatabaseClient {
  const pool = new Pool({ connectionString });

  return {
    database: drizzle({ client: pool, schema }),
    pool,
  };
}
