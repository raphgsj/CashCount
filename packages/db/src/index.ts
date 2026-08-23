export const packageName = '@cashcount/db' as const;

export { createDatabaseClient, type DatabaseClient } from './client.js';
export { defaultMigrationsFolder, runMigrations } from './migrations.js';
