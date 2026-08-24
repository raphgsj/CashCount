import type { Pool } from 'pg';

import type { PayloadEncryptionService } from './encryption.js';

export type WebhookProcessingStatus = 'FAILED' | 'IGNORED' | 'PROCESSED' | 'QUEUED' | 'UNMAPPED';

export interface WebhookProcessingEvent {
  eventType: string;
  externalAccountId: null | string;
  externalConnectionId: string;
  externalEventId: string;
  id: string;
  payload: unknown | null;
  status: WebhookProcessingStatus;
  workspaceId: null | string;
}

export interface WebhookConnectionTarget {
  localStatus: string;
  providerConnectionId: string;
}

interface WebhookRow {
  canonicalization_version: 'CASHCOUNT_JSON_V1';
  event_type: string;
  external_account_id: null | string;
  external_connection_id: string;
  external_event_id: string;
  id: string;
  key_version: number;
  payload_ciphertext: Buffer;
  payload_iv: Buffer;
  payload_sha256: string;
  payload_tag: Buffer;
  status: WebhookProcessingStatus;
  workspace_id: null | string;
}

interface ConnectionRow {
  id: string;
  local_status: string;
}

export class WebhookProcessingInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'WebhookProcessingInvariantError';
  }
}

const webhookColumns = `id, workspace_id, event_type, external_event_id,
  external_connection_id, external_account_id, status, payload_ciphertext,
  payload_iv, payload_tag, key_version, payload_sha256, canonicalization_version`;

export class WebhookProcessingRepository {
  public constructor(private readonly pool: Pool) {}

  public async withConnectionLock<Result>(
    workspaceId: string,
    externalConnectionId: string,
    action: () => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    const lockKey = `webhook-connection:${workspaceId}:${externalConnectionId}`;
    try {
      await client.query(`select pg_advisory_lock(hashtextextended($1, 0))`, [lockKey]);
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('Advisory lock failed.'));
      throw error;
    }

    let outcome: { error: unknown; succeeded: false } | { succeeded: true; value: Result };
    try {
      outcome = { succeeded: true, value: await action() };
    } catch (error) {
      outcome = { error, succeeded: false };
    }
    try {
      await client.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [lockKey]);
      client.release();
    } catch (error) {
      client.release(error instanceof Error ? error : new Error('Advisory unlock failed.'));
      throw error;
    }
    if (!outcome.succeeded) throw outcome.error;
    return outcome.value;
  }

  public async load(
    expectedWorkspaceId: null | string,
    webhookEventId: string,
    encryption: PayloadEncryptionService,
  ): Promise<WebhookProcessingEvent> {
    const claimed = await this.pool.query<WebhookRow>(
      `update webhook_event
       set attempt_count = attempt_count + 1, last_error_summary = null
       where id = $1 and workspace_id is not distinct from $2::uuid
         and status in ('QUEUED', 'FAILED')
       returning ${webhookColumns}`,
      [webhookEventId, expectedWorkspaceId],
    );
    let row = claimed.rows[0];
    if (row === undefined) {
      const existing = await this.pool.query<WebhookRow>(
        `select ${webhookColumns} from webhook_event where id = $1`,
        [webhookEventId],
      );
      row = existing.rows[0];
    }
    if (row === undefined) {
      throw new WebhookProcessingInvariantError('Webhook event is unavailable.');
    }
    if (row.workspace_id !== expectedWorkspaceId) {
      throw new WebhookProcessingInvariantError('Webhook job workspace does not match its event.');
    }

    const terminal =
      row.status === 'PROCESSED' || row.status === 'IGNORED' || row.status === 'UNMAPPED';
    const payload = terminal
      ? null
      : encryption.decryptJson(
          {
            authenticationTag: row.payload_tag,
            canonicalizationVersion: row.canonicalization_version,
            ciphertext: row.payload_ciphertext,
            keyVersion: row.key_version,
            nonce: row.payload_iv,
            payloadSha256: row.payload_sha256,
          },
          {
            entityType: row.event_type,
            externalId: row.external_event_id,
            provider: 'PLUGGY',
            recordId: row.id,
            storageTable: 'webhook_event',
            workspaceId: row.workspace_id,
          },
        );
    return {
      eventType: row.event_type,
      externalAccountId: row.external_account_id,
      externalConnectionId: row.external_connection_id,
      externalEventId: row.external_event_id,
      id: row.id,
      payload,
      status: row.status,
      workspaceId: row.workspace_id,
    };
  }

  public async resolveConnection(
    workspaceId: string,
    externalConnectionId: string,
  ): Promise<WebhookConnectionTarget> {
    const result = await this.pool.query<ConnectionRow>(
      `select id, local_status from provider_connection
       where workspace_id = $1 and provider = 'PLUGGY' and external_connection_id = $2
       limit 1`,
      [workspaceId, externalConnectionId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new WebhookProcessingInvariantError('Webhook connection mapping is unavailable.');
    }
    return { localStatus: row.local_status, providerConnectionId: row.id };
  }

  public async markConnectionSyncing(
    workspaceId: string,
    providerConnectionId: string,
    changedAt = new Date(),
  ): Promise<void> {
    const result = await this.pool.query(
      `update provider_connection
       set local_status = case
             when local_status in ('DELETED', 'DISABLED') then local_status
             else 'SYNCING'
           end,
           last_attempt_at = $3, updated_at = $3
       where workspace_id = $1 and id = $2 and provider = 'PLUGGY'
       returning id`,
      [workspaceId, providerConnectionId, changedAt],
    );
    if (result.rowCount !== 1) {
      throw new WebhookProcessingInvariantError('Webhook connection state update failed.');
    }
  }

  public async markConnectionDeleted(
    workspaceId: string,
    providerConnectionId: string,
    changedAt = new Date(),
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(
        `update provider_connection
         set local_status = 'DELETED',
             deleted_at = coalesce(deleted_at, $3), updated_at = $3
         where workspace_id = $1 and id = $2 and provider = 'PLUGGY'
         returning id`,
        [workspaceId, providerConnectionId, changedAt],
      );
      if (result.rowCount !== 1) {
        throw new WebhookProcessingInvariantError('Webhook connection deletion failed.');
      }
      await client.query(
        `update financial_account
         set is_active = false, updated_at = $3
         where workspace_id = $1 and provider_connection_id = $2 and provider = 'PLUGGY'`,
        [workspaceId, providerConnectionId, changedAt],
      );
      await client.query(
        `update job_queue
         set status = 'DEAD', finished_at = $3, last_error_code = 'CONNECTION_DELETED',
             last_error_summary = 'Connection was deleted before refresh execution.',
             locked_at = null, locked_by = null, heartbeat_at = null, lease_expires_at = null,
             updated_at = $3
         where workspace_id = $1 and status in ('PENDING', 'RETRY')
           and job_type in ('SYNC_CONNECTION', 'SYNC_ACCOUNT', 'SYNC_TRANSACTIONS_PAGE', 'SYNC_BILLS')
           and (
             payload ->> 'providerConnectionId' = $2::text
             or exists (
               select 1 from financial_account fa
               where fa.workspace_id = $1 and fa.provider_connection_id = $2::uuid
                 and fa.id::text = payload ->> 'financialAccountId'
             )
           )`,
        [workspaceId, providerConnectionId, changedAt],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordLifecycleAlert(
    workspaceId: string,
    providerConnectionId: string,
    webhookEventId: string,
    localStatus:
      'PROVIDER_ERROR' | 'REAUTH_REQUIRED' | 'USER_ACTION_REQUIRED' | 'USER_INPUT_REQUIRED',
    createdAt = new Date(),
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `webhook-alert:${workspaceId}:${webhookEventId}`,
      ]);
      await client.query(
        `insert into audit_event (
         workspace_id, actor_type, event_type, target_type, target_id, details, created_at
       )
       select $1, 'WORKER', 'PROVIDER_CONNECTION_ACTION_REQUIRED',
         'PROVIDER_CONNECTION', $2, jsonb_build_object(
           'localStatus', $4::text, 'provider', 'PLUGGY', 'webhookEventId', $3::text
         ), $5
       where not exists (
         select 1 from audit_event
         where workspace_id = $1
           and event_type = 'PROVIDER_CONNECTION_ACTION_REQUIRED'
           and target_type = 'PROVIDER_CONNECTION' and target_id = $2
           and details ->> 'webhookEventId' = $3
       )`,
        [workspaceId, providerConnectionId, webhookEventId, localStatus, createdAt],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  public async markProcessed(
    workspaceId: string,
    webhookEventId: string,
    processedAt = new Date(),
  ): Promise<void> {
    const result = await this.pool.query(
      `update webhook_event
       set status = 'PROCESSED', processed_at = coalesce(processed_at, $3),
           last_error_summary = null
       where workspace_id = $1 and id = $2 and status in ('QUEUED', 'FAILED', 'PROCESSED')
       returning id`,
      [workspaceId, webhookEventId, processedAt],
    );
    if (result.rowCount !== 1) {
      throw new WebhookProcessingInvariantError('Webhook completion failed.');
    }
  }

  public async markFailed(
    workspaceId: string,
    webhookEventId: string,
    errorSummary: string,
  ): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{0,99}$/u.test(errorSummary)) {
      throw new TypeError('Webhook error summary must be a bounded machine code.');
    }
    const result = await this.pool.query(
      `update webhook_event
       set status = 'FAILED', processed_at = null, last_error_summary = $3
       where workspace_id = $1 and id = $2 and status in ('QUEUED', 'FAILED')
       returning id`,
      [workspaceId, webhookEventId, errorSummary],
    );
    if (result.rowCount !== 1) {
      throw new WebhookProcessingInvariantError('Webhook failure recording failed.');
    }
  }
}
