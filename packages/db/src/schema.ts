import { sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import {
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

const zeroUuid = sql`'00000000-0000-0000-0000-000000000000'::uuid`;
const emptyJsonObject = sql`'{}'::jsonb`;

function timestamps() {
  return {
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  };
}

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    email: citext('email').notNull(),
    displayName: text('display_name'),
    authProvider: text('auth_provider').notNull(),
    authSubject: text('auth_subject').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    ...timestamps(),
  },
  (table) => [
    unique('app_user_email_uq').on(table.email),
    unique('app_user_auth_identity_uq').on(table.authProvider, table.authSubject),
    check('app_user_email_nonempty_ck', sql`length(trim(${table.email}::text)) > 0`),
    check('app_user_email_normalized_ck', sql`${table.email}::text = lower(${table.email}::text)`),
    check(
      'app_user_display_name_nonempty_ck',
      sql`${table.displayName} is null or length(trim(${table.displayName})) > 0`,
    ),
    check('app_user_auth_provider_nonempty_ck', sql`length(trim(${table.authProvider})) > 0`),
    check('app_user_auth_subject_nonempty_ck', sql`length(trim(${table.authSubject})) > 0`),
    check('app_user_status_ck', sql`${table.status} in ('ACTIVE', 'DISABLED')`),
  ],
);

export const workspace = pgTable(
  'workspace',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    baseCurrency: char('base_currency', { length: 3 }).notNull().default('BRL'),
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    analyticsPolicyVersion: integer('analytics_policy_version').notNull().default(1),
    ...timestamps(),
  },
  (table) => [
    check('workspace_name_nonempty_ck', sql`length(trim(${table.name})) > 0`),
    check('workspace_base_currency_ck', sql`${table.baseCurrency} ~ '^[A-Z]{3}$'`),
    check('workspace_timezone_nonempty_ck', sql`length(trim(${table.timezone})) > 0`),
    check('workspace_analytics_policy_version_ck', sql`${table.analyticsPolicyVersion} > 0`),
  ],
);

export const workspaceMember = pgTable(
  'workspace_member',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    role: text('role').notNull().default('OWNER'),
    ...timestamps(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.userId],
      name: 'workspace_member_pk',
    }),
    index('workspace_member_user_id_idx').on(table.userId),
    check('workspace_member_role_ck', sql`${table.role} = 'OWNER'`),
  ],
);

export const providerConnection = pgTable(
  'provider_connection',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    provider: text('provider').notNull(),
    externalConnectionId: text('external_connection_id').notNull(),
    externalConnectorId: text('external_connector_id').notNull(),
    displayName: text('display_name').notNull(),
    localStatus: text('local_status').notNull().default('ACTIVE'),
    providerItemStatus: text('provider_item_status'),
    providerExecutionStatus: text('provider_execution_status'),
    actionRequiredAt: timestamp('action_required_at', { withTimezone: true }),
    consentExpiresAt: timestamp('consent_expires_at', { withTimezone: true }),
    lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
    lastProviderUpdateAt: timestamp('last_provider_update_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorSummary: text('last_error_summary'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
    ...timestamps(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('provider_connection_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('provider_connection_external_identity_uq').on(
      table.workspaceId,
      table.provider,
      table.externalConnectionId,
    ),
    check('provider_connection_provider_ck', sql`${table.provider} = 'PLUGGY'`),
    check(
      'provider_connection_external_connection_id_nonempty_ck',
      sql`length(trim(${table.externalConnectionId})) > 0`,
    ),
    check(
      'provider_connection_external_connector_id_nonempty_ck',
      sql`length(trim(${table.externalConnectorId})) > 0`,
    ),
    check(
      'provider_connection_display_name_nonempty_ck',
      sql`length(trim(${table.displayName})) > 0`,
    ),
    check(
      'provider_connection_local_status_ck',
      sql`${table.localStatus} in ('ACTIVE', 'SYNCING', 'USER_INPUT_REQUIRED', 'USER_ACTION_REQUIRED', 'REAUTH_REQUIRED', 'PROVIDER_ERROR', 'DELETED', 'DISABLED')`,
    ),
    check(
      'provider_connection_last_error_summary_length_ck',
      sql`${table.lastErrorSummary} is null or length(${table.lastErrorSummary}) <= 1000`,
    ),
  ],
);

export const providerRawObject = pgTable(
  'provider_raw_object',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    provider: text('provider').notNull(),
    entityType: text('entity_type').notNull(),
    externalId: text('external_id').notNull(),
    payloadCiphertext: bytea('payload_ciphertext').notNull(),
    payloadIv: bytea('payload_iv').notNull(),
    payloadTag: bytea('payload_tag').notNull(),
    keyVersion: integer('key_version').notNull(),
    payloadSha256: char('payload_sha256', { length: 64 }).notNull(),
    sourceEventId: text('source_event_id'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }),
  },
  (table) => [
    unique('provider_raw_object_workspace_id_id_uq').on(table.workspaceId, table.id),
    index('provider_raw_object_identity_observed_idx').on(
      table.workspaceId,
      table.provider,
      table.entityType,
      table.externalId,
      table.observedAt.desc(),
    ),
    check('provider_raw_object_provider_ck', sql`${table.provider} = 'PLUGGY'`),
    check(
      'provider_raw_object_entity_type_nonempty_ck',
      sql`length(trim(${table.entityType})) > 0`,
    ),
    check(
      'provider_raw_object_external_id_nonempty_ck',
      sql`length(trim(${table.externalId})) > 0`,
    ),
    check(
      'provider_raw_object_envelope_nonempty_ck',
      sql`octet_length(${table.payloadCiphertext}) > 0 and octet_length(${table.payloadIv}) > 0 and octet_length(${table.payloadTag}) > 0`,
    ),
    check('provider_raw_object_key_version_ck', sql`${table.keyVersion} > 0`),
    check('provider_raw_object_payload_sha256_ck', sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const webhookEvent = pgTable(
  'webhook_event',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspace.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    provider: text('provider').notNull(),
    externalEventId: text('external_event_id').notNull(),
    eventType: text('event_type').notNull(),
    externalConnectionId: text('external_connection_id'),
    externalAccountId: text('external_account_id'),
    payloadCiphertext: bytea('payload_ciphertext').notNull(),
    payloadIv: bytea('payload_iv').notNull(),
    payloadTag: bytea('payload_tag').notNull(),
    keyVersion: integer('key_version').notNull(),
    payloadSha256: char('payload_sha256', { length: 64 }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    status: text('status').notNull().default('RECEIVED'),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastErrorSummary: text('last_error_summary'),
  },
  (table) => [
    unique('webhook_event_workspace_id_id_uq').on(table.workspaceId, table.id),
    uniqueIndex('webhook_event_external_identity_uq').on(
      sql`coalesce(${table.workspaceId}, ${zeroUuid})`,
      table.provider,
      table.externalEventId,
    ),
    check('webhook_event_provider_ck', sql`${table.provider} = 'PLUGGY'`),
    check(
      'webhook_event_external_event_id_nonempty_ck',
      sql`length(trim(${table.externalEventId})) > 0`,
    ),
    check('webhook_event_event_type_nonempty_ck', sql`length(trim(${table.eventType})) > 0`),
    check(
      'webhook_event_envelope_nonempty_ck',
      sql`octet_length(${table.payloadCiphertext}) > 0 and octet_length(${table.payloadIv}) > 0 and octet_length(${table.payloadTag}) > 0`,
    ),
    check('webhook_event_key_version_ck', sql`${table.keyVersion} > 0`),
    check('webhook_event_payload_sha256_ck', sql`${table.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'webhook_event_workspace_scope_ck',
      sql`(${table.workspaceId} is null and ${table.status} = 'UNMAPPED') or ${table.workspaceId} is not null`,
    ),
    check(
      'webhook_event_status_ck',
      sql`${table.status} in ('RECEIVED', 'QUEUED', 'PROCESSED', 'FAILED', 'IGNORED', 'UNMAPPED')`,
    ),
    check('webhook_event_attempt_count_ck', sql`${table.attemptCount} >= 0`),
    check(
      'webhook_event_last_error_summary_length_ck',
      sql`${table.lastErrorSummary} is null or length(${table.lastErrorSummary}) <= 1000`,
    ),
  ],
);

export const jobQueue = pgTable(
  'job_queue',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspace.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    jobType: text('job_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
    dedupeKey: text('dedupe_key'),
    status: text('status').notNull().default('PENDING'),
    priority: integer('priority').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: text('locked_by'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull(),
    lastErrorCode: text('last_error_code'),
    lastErrorSummary: text('last_error_summary'),
    ...timestamps(),
  },
  (table) => [
    unique('job_queue_workspace_id_id_uq').on(table.workspaceId, table.id),
    index('job_queue_claim_idx').on(table.status, table.availableAt, table.priority.desc()),
    uniqueIndex('job_queue_active_dedupe_uq')
      .on(sql`coalesce(${table.workspaceId}, ${zeroUuid})`, table.jobType, table.dedupeKey)
      .where(
        sql`${table.dedupeKey} is not null and ${table.status} in ('PENDING', 'RETRY', 'RUNNING')`,
      ),
    check('job_queue_job_type_nonempty_ck', sql`length(trim(${table.jobType})) > 0`),
    check(
      'job_queue_dedupe_key_nonempty_ck',
      sql`${table.dedupeKey} is null or length(trim(${table.dedupeKey})) > 0`,
    ),
    check(
      'job_queue_status_ck',
      sql`${table.status} in ('PENDING', 'RUNNING', 'SUCCEEDED', 'RETRY', 'DEAD')`,
    ),
    check('job_queue_attempt_count_ck', sql`${table.attemptCount} >= 0`),
    check('job_queue_max_attempts_ck', sql`${table.maxAttempts} > 0`),
    check('job_queue_attempt_limit_ck', sql`${table.attemptCount} <= ${table.maxAttempts}`),
    check(
      'job_queue_running_lease_ck',
      sql`${table.status} <> 'RUNNING' or (${table.lockedAt} is not null and ${table.lockedBy} is not null and length(trim(${table.lockedBy})) > 0 and ${table.startedAt} is not null and ${table.heartbeatAt} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
    check(
      'job_queue_terminal_finished_at_ck',
      sql`${table.status} not in ('SUCCEEDED', 'DEAD') or ${table.finishedAt} is not null`,
    ),
    check(
      'job_queue_last_error_summary_length_ck',
      sql`${table.lastErrorSummary} is null or length(${table.lastErrorSummary}) <= 1000`,
    ),
  ],
);

export const syncRun = pgTable(
  'sync_run',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    providerConnectionId: uuid('provider_connection_id').notNull(),
    triggerType: text('trigger_type').notNull(),
    status: text('status').notNull().default('RUNNING'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    accountsSeen: integer('accounts_seen').notNull().default(0),
    transactionsSeen: integer('transactions_seen').notNull().default(0),
    transactionsInserted: integer('transactions_inserted').notNull().default(0),
    transactionsUpdated: integer('transactions_updated').notNull().default(0),
    transactionsDeleted: integer('transactions_deleted').notNull().default(0),
    billsSeen: integer('bills_seen').notNull().default(0),
    cursorState: jsonb('cursor_state')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(emptyJsonObject),
    errorSummary: text('error_summary'),
  },
  (table) => [
    unique('sync_run_workspace_id_id_uq').on(table.workspaceId, table.id),
    foreignKey({
      columns: [table.workspaceId, table.providerConnectionId],
      foreignColumns: [providerConnection.workspaceId, providerConnection.id],
      name: 'sync_run_workspace_provider_connection_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('sync_run_provider_connection_started_idx').on(
      table.providerConnectionId,
      table.startedAt.desc(),
    ),
    check(
      'sync_run_trigger_type_ck',
      sql`${table.triggerType} in ('INITIAL', 'WEBHOOK', 'MANUAL', 'SCHEDULED', 'RECOVERY')`,
    ),
    check(
      'sync_run_status_ck',
      sql`${table.status} in ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED')`,
    ),
    check(
      'sync_run_finished_at_ck',
      sql`(${table.status} = 'RUNNING' and ${table.finishedAt} is null) or (${table.status} <> 'RUNNING' and ${table.finishedAt} is not null)`,
    ),
    check(
      'sync_run_counters_ck',
      sql`${table.accountsSeen} >= 0 and ${table.transactionsSeen} >= 0 and ${table.transactionsInserted} >= 0 and ${table.transactionsUpdated} >= 0 and ${table.transactionsDeleted} >= 0 and ${table.billsSeen} >= 0`,
    ),
    check(
      'sync_run_error_summary_length_ck',
      sql`${table.errorSummary} is null or length(${table.errorSummary}) <= 1000`,
    ),
  ],
);

export const financialAccount = pgTable(
  'financial_account',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    providerConnectionId: uuid('provider_connection_id').notNull(),
    provider: text('provider').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    accountType: text('account_type').notNull(),
    accountSubtype: text('account_subtype'),
    name: text('name').notNull(),
    institutionName: text('institution_name').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    maskedNumber: text('masked_number'),
    currentBalance: numeric('current_balance', { precision: 20, scale: 6 }),
    availableBalance: numeric('available_balance', { precision: 20, scale: 6 }),
    creditLimit: numeric('credit_limit', { precision: 20, scale: 6 }),
    availableCreditLimit: numeric('available_credit_limit', { precision: 20, scale: 6 }),
    closingDay: smallint('closing_day'),
    dueDay: smallint('due_day'),
    isActive: boolean('is_active').notNull().default(true),
    providerUpdatedAt: timestamp('provider_updated_at', { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp('last_successful_sync_at', { withTimezone: true }),
    latestRawObjectId: uuid('latest_raw_object_id'),
    providerHistoryEarliestDate: date('provider_history_earliest_date'),
    providerHistoryLatestDate: date('provider_history_latest_date'),
    initialImportCompletedAt: timestamp('initial_import_completed_at', { withTimezone: true }),
    historyCoverageStatus: text('history_coverage_status').notNull().default('UNKNOWN'),
    historyCoverageNote: text('history_coverage_note'),
    ...timestamps(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('financial_account_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('financial_account_external_identity_uq').on(
      table.workspaceId,
      table.provider,
      table.externalAccountId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.providerConnectionId],
      foreignColumns: [providerConnection.workspaceId, providerConnection.id],
      name: 'financial_account_workspace_provider_connection_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.latestRawObjectId],
      foreignColumns: [providerRawObject.workspaceId, providerRawObject.id],
      name: 'financial_account_workspace_latest_raw_object_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('financial_account_provider_ck', sql`${table.provider} = 'PLUGGY'`),
    check(
      'financial_account_external_account_id_nonempty_ck',
      sql`length(trim(${table.externalAccountId})) > 0`,
    ),
    check(
      'financial_account_type_ck',
      sql`${table.accountType} in ('CHECKING', 'SAVINGS', 'CREDIT_CARD', 'INVESTMENT', 'OTHER')`,
    ),
    check('financial_account_name_nonempty_ck', sql`length(trim(${table.name})) > 0`),
    check(
      'financial_account_institution_name_nonempty_ck',
      sql`length(trim(${table.institutionName})) > 0`,
    ),
    check('financial_account_currency_ck', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'financial_account_masked_number_ck',
      sql`${table.maskedNumber} is null or ${table.maskedNumber} ~ '^[0-9]{1,4}$'`,
    ),
    check(
      'financial_account_closing_day_ck',
      sql`${table.closingDay} is null or ${table.closingDay} between 1 and 31`,
    ),
    check(
      'financial_account_due_day_ck',
      sql`${table.dueDay} is null or ${table.dueDay} between 1 and 31`,
    ),
    check(
      'financial_account_history_dates_ck',
      sql`${table.providerHistoryEarliestDate} is null or ${table.providerHistoryLatestDate} is null or ${table.providerHistoryEarliestDate} <= ${table.providerHistoryLatestDate}`,
    ),
    check(
      'financial_account_history_coverage_status_ck',
      sql`${table.historyCoverageStatus} in ('UNKNOWN', 'PARTIAL', 'PROVIDER_MAXIMUM_RETRIEVED', 'USER_EXTENDED_HISTORY')`,
    ),
    check(
      'financial_account_history_coverage_note_length_ck',
      sql`${table.historyCoverageNote} is null or length(${table.historyCoverageNote}) <= 1000`,
    ),
  ],
);

export const category = pgTable(
  'category',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspace.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    code: text('code').notNull(),
    parentId: uuid('parent_id').references((): AnyPgColumn => category.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    kind: text('kind').notNull(),
    nameEn: text('name_en').notNull(),
    namePtBr: text('name_pt_br').notNull(),
    iconKey: text('icon_key'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex('category_builtin_code_uq')
      .on(table.code)
      .where(sql`${table.workspaceId} is null`),
    uniqueIndex('category_workspace_code_uq')
      .on(table.workspaceId, table.code)
      .where(sql`${table.workspaceId} is not null`),
    check('category_code_nonempty_ck', sql`length(trim(${table.code})) > 0`),
    check(
      'category_parent_not_self_ck',
      sql`${table.parentId} is null or ${table.parentId} <> ${table.id}`,
    ),
    check('category_kind_ck', sql`${table.kind} in ('EXPENSE', 'INCOME', 'TRANSFER', 'OTHER')`),
    check('category_name_en_nonempty_ck', sql`length(trim(${table.nameEn})) > 0`),
    check('category_name_pt_br_nonempty_ck', sql`length(trim(${table.namePtBr})) > 0`),
    check(
      'category_code_scope_ck',
      sql`(${table.workspaceId} is null and ${table.code} !~ '^custom\\.') or (${table.workspaceId} is not null and ${table.code} ~ '^custom\\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')`,
    ),
  ],
);

export const merchant = pgTable(
  'merchant',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    canonicalName: text('canonical_name').notNull(),
    normalizedKey: text('normalized_key').notNull(),
    merchantGroup: text('merchant_group'),
    mcc: text('mcc'),
    cnpjHash: char('cnpj_hash', { length: 64 }),
    defaultCategoryId: uuid('default_category_id').references(() => category.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    reviewStatus: text('review_status').notNull().default('NEEDS_REVIEW'),
    ...timestamps(),
  },
  (table) => [
    unique('merchant_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('merchant_workspace_normalized_key_uq').on(table.workspaceId, table.normalizedKey),
    check('merchant_canonical_name_nonempty_ck', sql`length(trim(${table.canonicalName})) > 0`),
    check('merchant_normalized_key_nonempty_ck', sql`length(trim(${table.normalizedKey})) > 0`),
    check(
      'merchant_cnpj_hash_ck',
      sql`${table.cnpjHash} is null or ${table.cnpjHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'merchant_review_status_ck',
      sql`${table.reviewStatus} in ('AUTO', 'CONFIRMED', 'NEEDS_REVIEW')`,
    ),
  ],
);

export const merchantAlias = pgTable(
  'merchant_alias',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    merchantId: uuid('merchant_id').notNull(),
    aliasNormalized: text('alias_normalized').notNull(),
    matchType: text('match_type').notNull(),
    source: text('source').notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 4 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    unique('merchant_alias_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('merchant_alias_workspace_alias_normalized_uq').on(
      table.workspaceId,
      table.aliasNormalized,
    ),
    foreignKey({
      columns: [table.workspaceId, table.merchantId],
      foreignColumns: [merchant.workspaceId, merchant.id],
      name: 'merchant_alias_workspace_merchant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'merchant_alias_alias_normalized_nonempty_ck',
      sql`length(trim(${table.aliasNormalized})) > 0`,
    ),
    check(
      'merchant_alias_match_type_ck',
      sql`${table.matchType} in ('EXACT', 'PREFIX', 'CONTAINS', 'REGEX')`,
    ),
    check(
      'merchant_alias_source_ck',
      sql`${table.source} in ('USER', 'PROVIDER', 'HEURISTIC', 'IMPORT')`,
    ),
    check('merchant_alias_confidence_ck', sql`${table.confidence} between 0 and 1`),
  ],
);

export const creditCardBill = pgTable(
  'credit_card_bill',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    financialAccountId: uuid('financial_account_id').notNull(),
    provider: text('provider').notNull(),
    externalBillId: text('external_bill_id').notNull(),
    status: text('status').notNull(),
    dueDate: date('due_date'),
    closeDate: date('close_date'),
    totalAmount: numeric('total_amount', { precision: 20, scale: 6 }),
    minimumPayment: numeric('minimum_payment', { precision: 20, scale: 6 }),
    currency: char('currency', { length: 3 }).notNull(),
    allowsInstallments: boolean('allows_installments'),
    providerStatus: text('provider_status'),
    reconciliationStatus: text('reconciliation_status'),
    latestRawObjectId: uuid('latest_raw_object_id'),
    ...timestamps(),
  },
  (table) => [
    unique('credit_card_bill_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('credit_card_bill_external_identity_uq').on(
      table.workspaceId,
      table.provider,
      table.externalBillId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.financialAccountId],
      foreignColumns: [financialAccount.workspaceId, financialAccount.id],
      name: 'credit_card_bill_workspace_financial_account_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.latestRawObjectId],
      foreignColumns: [providerRawObject.workspaceId, providerRawObject.id],
      name: 'credit_card_bill_workspace_latest_raw_object_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('credit_card_bill_provider_ck', sql`${table.provider} = 'PLUGGY'`),
    check(
      'credit_card_bill_external_bill_id_nonempty_ck',
      sql`length(trim(${table.externalBillId})) > 0`,
    ),
    check('credit_card_bill_status_nonempty_ck', sql`length(trim(${table.status})) > 0`),
    check('credit_card_bill_currency_ck', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'credit_card_bill_amounts_ck',
      sql`(${table.totalAmount} is null or ${table.totalAmount} >= 0) and (${table.minimumPayment} is null or ${table.minimumPayment} >= 0)`,
    ),
    check(
      'credit_card_bill_reconciliation_status_length_ck',
      sql`${table.reconciliationStatus} is null or length(${table.reconciliationStatus}) <= 100`,
    ),
  ],
);

export const financialTransaction = pgTable(
  'financial_transaction',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    financialAccountId: uuid('financial_account_id').notNull(),
    provider: text('provider').notNull(),
    providerTransactionId: text('provider_transaction_id'),
    providerId: text('provider_id'),
    providerCode: text('provider_code'),
    status: text('status').notNull().default('UNKNOWN'),
    providerType: text('provider_type'),
    providerOperationType: text('provider_operation_type'),
    providerOperationTypeAdditionalInfo: text('provider_operation_type_additional_info'),
    providerAmountSigned: numeric('provider_amount_signed', { precision: 20, scale: 6 }).notNull(),
    providerCurrency: char('provider_currency', { length: 3 }).notNull(),
    accountCurrencyAmountSigned: numeric('account_currency_amount_signed', {
      precision: 20,
      scale: 6,
    }),
    accountCurrency: char('account_currency', { length: 3 }).notNull(),
    systemDirection: text('system_direction').notNull().default('UNKNOWN'),
    systemFinancialRole: text('system_financial_role').notNull().default('UNKNOWN'),
    systemIsExcludedFromSpend: boolean('system_is_excluded_from_spend').notNull().default(false),
    providerTransactionAt: timestamp('provider_transaction_at', { withTimezone: true }).notNull(),
    transactionLocalDate: date('transaction_local_date').notNull(),
    providerPurchaseAt: timestamp('provider_purchase_at', { withTimezone: true }),
    purchaseLocalDate: date('purchase_local_date'),
    descriptionOriginal: text('description_original').notNull(),
    descriptionRaw: text('description_raw'),
    descriptionNormalized: text('description_normalized').notNull(),
    providerCategoryId: text('provider_category_id'),
    providerCategoryName: text('provider_category_name'),
    systemMerchantId: uuid('system_merchant_id'),
    systemCategoryId: uuid('system_category_id').references(() => category.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    systemCategorySource: text('system_category_source').notNull().default('NONE'),
    systemCategoryConfidence: numeric('system_category_confidence', { precision: 5, scale: 4 }),
    systemMerchantSource: text('system_merchant_source').notNull().default('NONE'),
    systemMerchantConfidence: numeric('system_merchant_confidence', { precision: 5, scale: 4 }),
    systemFinancialRoleSource: text('system_financial_role_source').notNull().default('NONE'),
    systemFinancialRoleConfidence: numeric('system_financial_role_confidence', {
      precision: 5,
      scale: 4,
    }),
    systemExclusionSource: text('system_exclusion_source').notNull().default('NONE'),
    installmentNumber: integer('installment_number'),
    installmentTotal: integer('installment_total'),
    installmentTotalAmount: numeric('installment_total_amount', { precision: 20, scale: 6 }),
    payeeMcc: text('payee_mcc'),
    cardLastFour: text('card_last_four'),
    providerBillId: text('provider_bill_id'),
    creditCardBillId: uuid('credit_card_bill_id'),
    billForecastMonth: date('bill_forecast_month'),
    feeType: text('fee_type'),
    feeTypeAdditionalInfo: text('fee_type_additional_info'),
    otherCreditsType: text('other_credits_type'),
    otherCreditsAdditionalInfo: text('other_credits_additional_info'),
    installmentSeriesId: uuid('installment_series_id'),
    recurringSeriesId: uuid('recurring_series_id'),
    transferPairId: uuid('transfer_pair_id'),
    duplicateReviewStatus: text('duplicate_review_status').notNull().default('NONE'),
    dedupeFingerprint: char('dedupe_fingerprint', { length: 64 }).notNull(),
    latestRawObjectId: uuid('latest_raw_object_id'),
    ...timestamps(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('financial_transaction_workspace_id_id_uq').on(table.workspaceId, table.id),
    uniqueIndex('financial_transaction_provider_identity_uq')
      .on(table.workspaceId, table.provider, table.providerTransactionId)
      .where(sql`${table.providerTransactionId} is not null`),
    index('financial_transaction_workspace_local_date_idx').on(
      table.workspaceId,
      table.transactionLocalDate.desc(),
      table.id.desc(),
    ),
    index('financial_transaction_workspace_category_date_idx').on(
      table.workspaceId,
      table.systemCategoryId,
      table.transactionLocalDate.desc(),
    ),
    index('financial_transaction_workspace_merchant_date_idx').on(
      table.workspaceId,
      table.systemMerchantId,
      table.transactionLocalDate.desc(),
    ),
    index('financial_transaction_workspace_account_date_idx').on(
      table.workspaceId,
      table.financialAccountId,
      table.transactionLocalDate.desc(),
    ),
    index('financial_transaction_dedupe_fingerprint_idx').on(table.dedupeFingerprint),
    index('financial_transaction_workspace_status_active_idx')
      .on(table.workspaceId, table.status)
      .where(sql`${table.deletedAt} is null`),
    foreignKey({
      columns: [table.workspaceId, table.financialAccountId],
      foreignColumns: [financialAccount.workspaceId, financialAccount.id],
      name: 'financial_transaction_workspace_financial_account_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.systemMerchantId],
      foreignColumns: [merchant.workspaceId, merchant.id],
      name: 'financial_transaction_workspace_system_merchant_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.creditCardBillId],
      foreignColumns: [creditCardBill.workspaceId, creditCardBill.id],
      name: 'financial_transaction_workspace_credit_card_bill_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.transferPairId],
      foreignColumns: [table.workspaceId, table.id],
      name: 'financial_transaction_workspace_transfer_pair_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.latestRawObjectId],
      foreignColumns: [providerRawObject.workspaceId, providerRawObject.id],
      name: 'financial_transaction_workspace_latest_raw_object_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('financial_transaction_provider_ck', sql`${table.provider} = 'PLUGGY'`),
    check(
      'financial_transaction_provider_transaction_id_nonempty_ck',
      sql`${table.providerTransactionId} is null or length(trim(${table.providerTransactionId})) > 0`,
    ),
    check(
      'financial_transaction_status_ck',
      sql`${table.status} in ('PENDING', 'POSTED', 'DELETED', 'UNKNOWN')`,
    ),
    check(
      'financial_transaction_provider_type_ck',
      sql`${table.providerType} is null or ${table.providerType} in ('DEBIT', 'CREDIT')`,
    ),
    check(
      'financial_transaction_currency_ck',
      sql`${table.providerCurrency} ~ '^[A-Z]{3}$' and ${table.accountCurrency} ~ '^[A-Z]{3}$'`,
    ),
    check(
      'financial_transaction_system_direction_ck',
      sql`${table.systemDirection} in ('INFLOW', 'OUTFLOW', 'NEUTRAL', 'UNKNOWN')`,
    ),
    check(
      'financial_transaction_system_financial_role_ck',
      sql`${table.systemFinancialRole} in ('PURCHASE', 'INCOME', 'TRANSFER', 'CARD_BILL_PAYMENT', 'REFUND', 'FEE', 'TAX', 'CASH_WITHDRAWAL', 'ADJUSTMENT', 'INVESTMENT_MOVEMENT', 'CREDIT', 'UNKNOWN_CREDIT', 'UNKNOWN')`,
    ),
    check(
      'financial_transaction_category_source_ck',
      sql`${table.systemCategorySource} in ('RULE', 'MERCHANT', 'HEURISTIC', 'PROVIDER', 'MODEL', 'NONE')`,
    ),
    check(
      'financial_transaction_merchant_source_ck',
      sql`${table.systemMerchantSource} in ('RULE', 'MERCHANT', 'HEURISTIC', 'PROVIDER', 'MODEL', 'NONE')`,
    ),
    check(
      'financial_transaction_role_source_ck',
      sql`${table.systemFinancialRoleSource} in ('RULE', 'HEURISTIC', 'PROVIDER', 'MODEL', 'NONE')`,
    ),
    check(
      'financial_transaction_exclusion_source_nonempty_ck',
      sql`length(trim(${table.systemExclusionSource})) > 0`,
    ),
    check(
      'financial_transaction_confidence_ck',
      sql`(${table.systemCategoryConfidence} is null or ${table.systemCategoryConfidence} between 0 and 1) and (${table.systemMerchantConfidence} is null or ${table.systemMerchantConfidence} between 0 and 1) and (${table.systemFinancialRoleConfidence} is null or ${table.systemFinancialRoleConfidence} between 0 and 1)`,
    ),
    check(
      'financial_transaction_installment_ck',
      sql`(${table.installmentNumber} is null and ${table.installmentTotal} is null) or (${table.installmentNumber} between 1 and ${table.installmentTotal} and ${table.installmentTotal} > 0)`,
    ),
    check(
      'financial_transaction_card_last_four_ck',
      sql`${table.cardLastFour} is null or ${table.cardLastFour} ~ '^[0-9]{4}$'`,
    ),
    check(
      'financial_transaction_bill_forecast_month_ck',
      sql`${table.billForecastMonth} is null or ${table.billForecastMonth} = date_trunc('month', ${table.billForecastMonth})::date`,
    ),
    check(
      'financial_transaction_duplicate_review_status_ck',
      sql`${table.duplicateReviewStatus} in ('NONE', 'POSSIBLE', 'CONFIRMED_DUPLICATE', 'CONFIRMED_DISTINCT')`,
    ),
    check(
      'financial_transaction_dedupe_fingerprint_ck',
      sql`${table.dedupeFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'financial_transaction_transfer_pair_not_self_ck',
      sql`${table.transferPairId} is null or ${table.transferPairId} <> ${table.id}`,
    ),
    check(
      'financial_transaction_future_series_unset_ck',
      sql`${table.installmentSeriesId} is null and ${table.recurringSeriesId} is null`,
    ),
    check(
      'financial_transaction_bounded_text_ck',
      sql`length(${table.descriptionOriginal}) between 1 and 1000 and length(${table.descriptionNormalized}) between 1 and 1000 and (${table.providerOperationTypeAdditionalInfo} is null or length(${table.providerOperationTypeAdditionalInfo}) <= 1000) and (${table.feeTypeAdditionalInfo} is null or length(${table.feeTypeAdditionalInfo}) <= 1000) and (${table.otherCreditsAdditionalInfo} is null or length(${table.otherCreditsAdditionalInfo}) <= 1000)`,
    ),
  ],
);

export const transactionUserState = pgTable(
  'transaction_user_state',
  {
    financialTransactionId: uuid('financial_transaction_id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    categoryOverrideEnabled: boolean('category_override_enabled').notNull().default(false),
    categoryIdOverride: uuid('category_id_override').references(() => category.id, {
      onDelete: 'restrict',
      onUpdate: 'restrict',
    }),
    merchantOverrideEnabled: boolean('merchant_override_enabled').notNull().default(false),
    merchantIdOverride: uuid('merchant_id_override'),
    financialRoleOverrideEnabled: boolean('financial_role_override_enabled')
      .notNull()
      .default(false),
    financialRoleOverride: text('financial_role_override'),
    excludedFromSpendOverride: boolean('excluded_from_spend_override'),
    notes: text('notes'),
    reviewStatus: text('review_status').notNull().default('UNREVIEWED'),
    version: integer('version').notNull().default(1),
    updatedByActorType: text('updated_by_actor_type').notNull(),
    updatedByActorId: text('updated_by_actor_id'),
    ...timestamps(),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.financialTransactionId],
      foreignColumns: [financialTransaction.workspaceId, financialTransaction.id],
      name: 'transaction_user_state_workspace_financial_transaction_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.merchantIdOverride],
      foreignColumns: [merchant.workspaceId, merchant.id],
      name: 'transaction_user_state_workspace_merchant_override_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'transaction_user_state_financial_role_override_ck',
      sql`(${table.financialRoleOverrideEnabled} and ${table.financialRoleOverride} in ('PURCHASE', 'INCOME', 'TRANSFER', 'CARD_BILL_PAYMENT', 'REFUND', 'FEE', 'TAX', 'CASH_WITHDRAWAL', 'ADJUSTMENT', 'INVESTMENT_MOVEMENT', 'CREDIT', 'UNKNOWN_CREDIT', 'UNKNOWN')) or (not ${table.financialRoleOverrideEnabled} and ${table.financialRoleOverride} is null)`,
    ),
    check(
      'transaction_user_state_category_override_ck',
      sql`${table.categoryOverrideEnabled} or ${table.categoryIdOverride} is null`,
    ),
    check(
      'transaction_user_state_merchant_override_ck',
      sql`${table.merchantOverrideEnabled} or ${table.merchantIdOverride} is null`,
    ),
    check(
      'transaction_user_state_review_status_ck',
      sql`${table.reviewStatus} in ('UNREVIEWED', 'NEEDS_REVIEW', 'CONFIRMED', 'IGNORED')`,
    ),
    check('transaction_user_state_version_ck', sql`${table.version} > 0`),
    check(
      'transaction_user_state_actor_type_ck',
      sql`${table.updatedByActorType} in ('USER', 'SYSTEM', 'MIGRATION')`,
    ),
    check(
      'transaction_user_state_notes_length_ck',
      sql`${table.notes} is null or length(${table.notes}) <= 4000`,
    ),
  ],
);

export const transactionIdentityLink = pgTable(
  'transaction_identity_link',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    predecessorTransactionId: uuid('predecessor_transaction_id').notNull(),
    successorTransactionId: uuid('successor_transaction_id').notNull(),
    linkType: text('link_type').notNull().default('PROVIDER_REPLACEMENT'),
    status: text('status').notNull().default('NEEDS_REVIEW'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().notNull().default(emptyJsonObject),
    detectedAt: timestamp('detected_at', { withTimezone: true }).defaultNow().notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by'),
  },
  (table) => [
    unique('transaction_identity_link_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('transaction_identity_link_candidate_uq').on(
      table.workspaceId,
      table.predecessorTransactionId,
      table.successorTransactionId,
      table.linkType,
    ),
    uniqueIndex('transaction_identity_link_active_predecessor_uq')
      .on(table.workspaceId, table.predecessorTransactionId)
      .where(sql`${table.status} in ('AUTO_CONFIRMED', 'USER_CONFIRMED')`),
    foreignKey({
      columns: [table.workspaceId, table.predecessorTransactionId],
      foreignColumns: [financialTransaction.workspaceId, financialTransaction.id],
      name: 'transaction_identity_link_workspace_predecessor_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.successorTransactionId],
      foreignColumns: [financialTransaction.workspaceId, financialTransaction.id],
      name: 'transaction_identity_link_workspace_successor_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'transaction_identity_link_not_self_ck',
      sql`${table.predecessorTransactionId} <> ${table.successorTransactionId}`,
    ),
    check('transaction_identity_link_type_ck', sql`${table.linkType} = 'PROVIDER_REPLACEMENT'`),
    check(
      'transaction_identity_link_status_ck',
      sql`${table.status} in ('AUTO_CONFIRMED', 'NEEDS_REVIEW', 'USER_CONFIRMED', 'REJECTED')`,
    ),
    check(
      'transaction_identity_link_confidence_ck',
      sql`${table.confidence} is null or ${table.confidence} between 0 and 1`,
    ),
    check(
      'transaction_identity_link_confirmation_ck',
      sql`${table.status} not in ('AUTO_CONFIRMED', 'USER_CONFIRMED') or ${table.confirmedAt} is not null`,
    ),
    check(
      'transaction_identity_link_evidence_length_ck',
      sql`octet_length(${table.evidence}::text) <= 10000`,
    ),
  ],
);

export const transactionRevision = pgTable(
  'transaction_revision',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    financialTransactionId: uuid('financial_transaction_id').notNull(),
    changeType: text('change_type').notNull(),
    changedFields: jsonb('changed_fields').$type<Record<string, unknown>>().notNull(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique('transaction_revision_workspace_id_id_uq').on(table.workspaceId, table.id),
    foreignKey({
      columns: [table.workspaceId, table.financialTransactionId],
      foreignColumns: [financialTransaction.workspaceId, financialTransaction.id],
      name: 'transaction_revision_workspace_financial_transaction_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    index('transaction_revision_transaction_created_idx').on(
      table.financialTransactionId,
      table.createdAt.desc(),
    ),
    check(
      'transaction_revision_change_type_ck',
      sql`${table.changeType} in ('PROVIDER_UPDATE', 'MANUAL_EDIT', 'CLASSIFICATION', 'MERGE', 'DELETE')`,
    ),
    check(
      'transaction_revision_actor_type_ck',
      sql`${table.actorType} in ('USER', 'WORKER', 'SYSTEM', 'MCP')`,
    ),
    check(
      'transaction_revision_changed_fields_length_ck',
      sql`octet_length(${table.changedFields}::text) <= 20000`,
    ),
  ],
);

export const creditCardBillPayment = pgTable(
  'credit_card_bill_payment',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    creditCardBillId: uuid('credit_card_bill_id').notNull(),
    provider: text('provider').notNull(),
    externalPaymentId: text('external_payment_id').notNull(),
    valueType: text('value_type').notNull(),
    paymentDate: date('payment_date').notNull(),
    paymentMode: text('payment_mode'),
    amount: numeric('amount', { precision: 20, scale: 6 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    matchedCardTransactionId: uuid('matched_card_transaction_id'),
    latestRawObjectId: uuid('latest_raw_object_id'),
    ...timestamps(),
  },
  (table) => [
    unique('credit_card_bill_payment_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('credit_card_bill_payment_external_identity_uq').on(
      table.workspaceId,
      table.creditCardBillId,
      table.provider,
      table.externalPaymentId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.creditCardBillId],
      foreignColumns: [creditCardBill.workspaceId, creditCardBill.id],
      name: 'credit_card_bill_payment_workspace_bill_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.matchedCardTransactionId],
      foreignColumns: [financialTransaction.workspaceId, financialTransaction.id],
      name: 'credit_card_bill_payment_workspace_matched_card_transaction_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.latestRawObjectId],
      foreignColumns: [providerRawObject.workspaceId, providerRawObject.id],
      name: 'credit_card_bill_payment_workspace_latest_raw_object_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('credit_card_bill_payment_provider_ck', sql`${table.provider} = 'PLUGGY'`),
    check(
      'credit_card_bill_payment_external_payment_id_nonempty_ck',
      sql`length(trim(${table.externalPaymentId})) > 0`,
    ),
    check(
      'credit_card_bill_payment_value_type_nonempty_ck',
      sql`length(trim(${table.valueType})) > 0`,
    ),
    check('credit_card_bill_payment_amount_ck', sql`${table.amount} >= 0`),
    check('credit_card_bill_payment_currency_ck', sql`${table.currency} ~ '^[A-Z]{3}$'`),
  ],
);

export const creditCardBillFinanceCharge = pgTable(
  'credit_card_bill_finance_charge',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    creditCardBillId: uuid('credit_card_bill_id').notNull(),
    provider: text('provider').notNull(),
    externalChargeId: text('external_charge_id').notNull(),
    chargeType: text('charge_type').notNull(),
    amount: numeric('amount', { precision: 20, scale: 6 }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    additionalInfo: text('additional_info'),
    matchedTransactionId: uuid('matched_transaction_id'),
    latestRawObjectId: uuid('latest_raw_object_id'),
    ...timestamps(),
  },
  (table) => [
    unique('credit_card_bill_finance_charge_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('credit_card_bill_finance_charge_external_identity_uq').on(
      table.workspaceId,
      table.creditCardBillId,
      table.provider,
      table.externalChargeId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.creditCardBillId],
      foreignColumns: [creditCardBill.workspaceId, creditCardBill.id],
      name: 'credit_card_bill_finance_charge_workspace_bill_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.matchedTransactionId],
      foreignColumns: [financialTransaction.workspaceId, financialTransaction.id],
      name: 'credit_card_bill_finance_charge_workspace_matched_transaction_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.latestRawObjectId],
      foreignColumns: [providerRawObject.workspaceId, providerRawObject.id],
      name: 'credit_card_bill_finance_charge_workspace_latest_raw_object_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check('credit_card_bill_finance_charge_provider_ck', sql`${table.provider} = 'PLUGGY'`),
    check(
      'credit_card_bill_finance_charge_external_charge_id_nonempty_ck',
      sql`length(trim(${table.externalChargeId})) > 0`,
    ),
    check(
      'credit_card_bill_finance_charge_charge_type_nonempty_ck',
      sql`length(trim(${table.chargeType})) > 0`,
    ),
    check('credit_card_bill_finance_charge_amount_ck', sql`${table.amount} >= 0`),
    check('credit_card_bill_finance_charge_currency_ck', sql`${table.currency} ~ '^[A-Z]{3}$'`),
    check(
      'credit_card_bill_finance_charge_additional_info_length_ck',
      sql`${table.additionalInfo} is null or length(${table.additionalInfo}) <= 1000`,
    ),
  ],
);

export const billPaymentReconciliation = pgTable(
  'bill_payment_reconciliation',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'restrict', onUpdate: 'restrict' }),
    creditCardBillPaymentId: uuid('credit_card_bill_payment_id').notNull(),
    financialTransactionId: uuid('financial_transaction_id').notNull(),
    matchStatus: text('match_status').notNull().default('UNMATCHED'),
    matchMethod: text('match_method').notNull().default('NONE'),
    confidence: numeric('confidence', { precision: 5, scale: 4 }),
    matchedAt: timestamp('matched_at', { withTimezone: true }),
    confirmedBy: text('confirmed_by'),
    ...timestamps(),
  },
  (table) => [
    unique('bill_payment_reconciliation_workspace_id_id_uq').on(table.workspaceId, table.id),
    unique('bill_payment_reconciliation_candidate_uq').on(
      table.workspaceId,
      table.creditCardBillPaymentId,
      table.financialTransactionId,
    ),
    uniqueIndex('bill_payment_reconciliation_active_payment_uq')
      .on(table.workspaceId, table.creditCardBillPaymentId)
      .where(sql`${table.matchStatus} in ('AUTO_MATCHED', 'USER_CONFIRMED')`),
    foreignKey({
      columns: [table.workspaceId, table.creditCardBillPaymentId],
      foreignColumns: [creditCardBillPayment.workspaceId, creditCardBillPayment.id],
      name: 'bill_payment_reconciliation_workspace_payment_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    foreignKey({
      columns: [table.workspaceId, table.financialTransactionId],
      foreignColumns: [financialTransaction.workspaceId, financialTransaction.id],
      name: 'bill_payment_reconciliation_workspace_transaction_fk',
    })
      .onDelete('restrict')
      .onUpdate('restrict'),
    check(
      'bill_payment_reconciliation_status_ck',
      sql`${table.matchStatus} in ('UNMATCHED', 'CANDIDATE', 'AUTO_MATCHED', 'USER_CONFIRMED', 'REJECTED')`,
    ),
    check(
      'bill_payment_reconciliation_match_method_nonempty_ck',
      sql`length(trim(${table.matchMethod})) > 0`,
    ),
    check(
      'bill_payment_reconciliation_confidence_ck',
      sql`${table.confidence} is null or ${table.confidence} between 0 and 1`,
    ),
    check(
      'bill_payment_reconciliation_matched_at_ck',
      sql`${table.matchStatus} not in ('AUTO_MATCHED', 'USER_CONFIRMED') or ${table.matchedAt} is not null`,
    ),
  ],
);
