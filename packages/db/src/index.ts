export const packageName = '@cashcount/db' as const;

export { createDatabaseClient, type DatabaseClient } from './client.js';
export { defaultMigrationsFolder, runMigrations } from './migrations.js';
export {
  canonicalJsonSha256,
  canonicalizeJson,
  EncryptionConfigurationError,
  EncryptionKeyRetirementError,
  MissingEncryptionKeyError,
  PayloadAuthenticationError,
  PayloadEncryptionService,
  payloadCanonicalizationVersion,
  type EncryptedPayloadEnvelope,
  type PayloadEncryptionContext,
  type PayloadEncryptionServiceOptions,
} from './encryption.js';
export { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';
export {
  ProviderConnectionRepository,
  type AssignedProviderConnection,
} from './provider-connection-repository.js';
export {
  financialRoles,
  TransactionNotFoundError,
  TransactionUserStateConflictError,
  TransactionUserStateRepository,
  transactionReviewStatuses,
  type EffectiveTransactionUserState,
  type FinancialRole,
  type NullableOverridePatch,
  type OverridePatch,
  type TransactionReviewStatus,
  type TransactionUserStateRecord,
  type UpdateTransactionUserStateInput,
  type UserStateActorType,
} from './transaction-user-state-repository.js';
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
  encryptionRotationRun,
  financialAccount,
  financialTransaction,
  installmentSeries,
  jobQueue,
  merchant,
  merchantAlias,
  providerConnection,
  providerRawObject,
  reconciliationCurrencyTolerance,
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
