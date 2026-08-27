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
  AccountCardRepository,
  type AccountCardRecord,
  type AccountType,
  type CardBillFinanceChargeRecord,
  type CardBillPaymentRecord,
  type CardBillRecord,
  type HistoryCoverageStatus,
} from './account-card-repository.js';
export {
  BillImportInvariantError,
  BillImportRepository,
  type BillImportAccount,
  type BillImportResult,
  type BillImportTarget,
} from './bill-import-repository.js';
export { createDatabaseClient, type DatabaseClient } from './client.js';
export {
  classificationQualitySources,
  ClassificationQualityRepository,
  type ClassificationQualityReport,
  type ClassificationQualitySource,
  type ClassificationQualitySourceDistribution,
  type ListUnclassifiedQueueInput,
  type UnclassifiedQueueCursor,
  type UnclassifiedQueueItem,
  type UnclassifiedQueuePage,
} from './classification-quality-repository.js';
export {
  FinancialRoleDetectionInvariantError,
  FinancialRoleDetectionRepository,
  type FinancialRoleDetectionKind,
  type FinancialRoleDetectionResult,
  type FinancialRoleDetectionStatus,
} from './financial-role-detection-repository.js';
export {
  ClassificationRuleInvariantError,
  ClassificationRuleRepository,
  ClassificationTransactionNotFoundError,
  type ClassificationRuleRecord,
  type ClassificationRuleSource,
  type ConfirmedClassificationRuleSuggestion,
  type CreateClassificationRuleInput,
  type PersistedRuleEvaluationResult,
} from './classification-rule-repository.js';
export {
  ClassificationManagementInvariantError,
  ClassificationManagementNotFoundError,
  ClassificationManagementRepository,
  type CreateManagedCategoryInput,
  type ManagedCategoryKind,
  type ManagedCategoryRecord,
  type ManagedClassificationRuleRecord,
  type ManagedMerchantAliasRecord,
  type ManagedMerchantRecord,
  type ManagedMerchantReviewStatus,
  type ManagedRulePreviewMatch,
  type ManagedRulePreviewResult,
  type UpdateManagedCategoryInput,
  type UpdateManagedMerchantInput,
  type UpdateManagedRuleInput,
} from './classification-management-repository.js';
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
  MerchantAliasConflictError,
  MerchantResolutionInvariantError,
  MerchantResolutionRepository,
  type ConfirmMerchantAliasInput,
  type CreateCanonicalMerchantInput,
  type MerchantRecord,
  type MerchantResolutionMethod,
  type MerchantResolutionResult,
  type MerchantReviewCandidate,
  type MerchantReviewReason,
  type MerchantReviewStatus,
  type ResolveMerchantInput,
} from './merchant-resolution-repository.js';
export {
  SyncOperationalRepository,
  type ManualReconciliationRequest,
  type OperationalDeadLetter,
  type OperationalSyncRun,
  type RetriedOperationalJob,
  type RetryDeadLetterResult,
} from './sync-operational-repository.js';
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
  TransactionApiRepository,
  type TransactionApiListInput,
  type TransactionApiPage,
  type TransactionApiRecord,
  type TransactionApiReplacementContext,
  type TransactionApiStatus,
  type TransactionApiTag,
  type TransactionApiUpdateInput,
  type TransactionApiWarning,
  type TransactionHistoryCoverageStatus,
} from './transaction-api-repository.js';
export {
  financialRoles,
  TransactionNotFoundError,
  TransactionUserStateConflictError,
  TransactionUserStateReferenceError,
  TransactionUserStateRepository,
  transactionReviewStatuses,
  type AppliedManualCorrection,
  type ApplyManualCorrectionInput,
  type EffectiveTransactionUserState,
  type FinancialRole,
  type ManualCorrectionApplication,
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
