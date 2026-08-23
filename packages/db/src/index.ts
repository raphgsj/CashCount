export const packageName = '@cashcount/db' as const;

export { createDatabaseClient, type DatabaseClient } from './client.js';
export { defaultMigrationsFolder, runMigrations } from './migrations.js';
export { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';
export {
  appUser,
  billPaymentReconciliation,
  category,
  creditCardBill,
  creditCardBillFinanceCharge,
  creditCardBillPayment,
  financialAccount,
  financialTransaction,
  jobQueue,
  merchant,
  merchantAlias,
  providerConnection,
  providerRawObject,
  syncRun,
  transactionIdentityLink,
  transactionRevision,
  transactionUserState,
  webhookEvent,
  workspace,
  workspaceMember,
} from './schema.js';
