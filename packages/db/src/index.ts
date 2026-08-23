export const packageName = '@cashcount/db' as const;

export { createDatabaseClient, type DatabaseClient } from './client.js';
export { defaultMigrationsFolder, runMigrations } from './migrations.js';
export { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';
export {
  appUser,
  auditEvent,
  billPaymentReconciliation,
  category,
  classificationDecision,
  classificationRule,
  creditCardBill,
  creditCardBillFinanceCharge,
  creditCardBillPayment,
  financialAccount,
  financialTransaction,
  installmentSeries,
  jobQueue,
  merchant,
  merchantAlias,
  providerConnection,
  providerRawObject,
  recurringSeries,
  syncRun,
  tag,
  transactionIdentityLink,
  transactionRevision,
  transactionTag,
  transactionUserState,
  webhookEvent,
  workspace,
  workspaceMember,
} from './schema.js';
