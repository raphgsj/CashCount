import { sql } from 'drizzle-orm';
import {
  char,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
