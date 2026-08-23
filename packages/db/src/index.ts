export const packageName = '@cashcount/db' as const;

export { createDatabaseClient, type DatabaseClient } from './client.js';
export { defaultMigrationsFolder, runMigrations } from './migrations.js';
export { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';
export {
  appUser,
  jobQueue,
  providerConnection,
  providerRawObject,
  syncRun,
  webhookEvent,
  workspace,
  workspaceMember,
} from './schema.js';
