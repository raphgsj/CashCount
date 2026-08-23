import { parseDatabaseConfig } from '@cashcount/config';

import { runMigrations } from './migrations.js';

const config = parseDatabaseConfig(process.env);

await runMigrations(config.databaseUrl);
