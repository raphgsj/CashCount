export const packageName = '@cashcount/db' as const;

export {
  AccountImportInvariantError,
  AccountImportRepository,
  type AccountImportResult,
  type AccountImportTarget,
} from './account-import-repository.js';
export {
  AccountHistoryCoverageRepository,
  type AccountHistoryCoverage,
  type AccountHistoryCoverageStatus,
  type IncompleteHistoryWarning,
} from './account-history-coverage-repository.js';
export {
  BillImportInvariantError,
  BillImportRepository,
  type BillImportAccount,
  type BillImportResult,
  type BillImportTarget,
} from './bill-import-repository.js';
export { createDatabaseClient, type DatabaseClient } from './client.js';
export {
  defaultQueueHeartbeatMs,
  defaultQueueLeaseMs,
  JobQueueRepository,
  QueueLeaseLostError,
  queueWorkerCapability,
  systemQueueCapability,
  type ClaimedQueueJob,
  type ClaimQueueJobInput,
  type FailQueueJobInput,
  type QueueJobStatus,
  type QueueWorkerCapability,
  type ReclaimedQueueJob,
  type ReclaimExpiredQueueJobsInput,
  type SystemQueueCapability,
} from './job-queue-repository.js';
export {
  queueJobTypes,
  type EnqueuedJob,
  type EnqueueJobInput,
  type QueueJobPayload,
  type QueueJobType,
} from './job-queue-insert.js';
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
  ReconciliationInvariantError,
  ReconciliationRepository,
  type ReconciliationConnectionTarget,
} from './reconciliation-repository.js';
export {
  TransactionImportInvariantError,
  TransactionImportRepository,
  type TransactionImportAccount,
  type TransactionPageImportResult,
  type TransactionSyncResult,
  type TransactionSyncStart,
  type TransactionSyncTrigger,
} from './transaction-import-repository.js';
export {
  TransactionReplacementInvariantError,
  TransactionReplacementRepository,
  TransactionReplacementTransferConflictError,
  type TransactionReplacementDetectionResult,
  type TransactionReplacementStatus,
  type TransactionReplacementTransferResult,
} from './transaction-replacement-repository.js';
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
  authenticatedWebhookIngestionCapability,
  WebhookInboxRepository,
  type AuthenticatedWebhookIngestionCapability,
  type PluggyWebhookInboxInput,
  type PluggyWebhookInboxResult,
} from './webhook-inbox-repository.js';
export {
  WebhookProcessingInvariantError,
  WebhookProcessingRepository,
  type WebhookConnectionTarget,
  type WebhookProcessingEvent,
  type WebhookProcessingStatus,
} from './webhook-processing-repository.js';
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
