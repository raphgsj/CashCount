import type { Pool } from 'pg';

import {
  providerConnectionLockKey,
  tryWithAdvisoryLock,
  withAdvisoryLock,
  type TryAdvisoryLockResult,
} from './advisory-lock.js';

export interface ReconciliationConnectionTarget {
  externalConnectionId: string;
  localStatus: string;
  providerConnectionId: string;
  workspaceId: string;
}

interface TargetRow {
  external_connection_id: string;
  id: string;
  local_status: string;
  workspace_id: string;
}

export class ReconciliationInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReconciliationInvariantError';
  }
}

export class ReconciliationRepository {
  public constructor(private readonly pool: Pool) {}

  public async tryRunExclusive<Result>(
    workspaceId: string,
    action: () => Promise<Result>,
  ): Promise<TryAdvisoryLockResult<Result>> {
    return tryWithAdvisoryLock(this.pool, `scheduled-reconciliation:${workspaceId}`, action);
  }

  public async withConnectionLock<Result>(
    workspaceId: string,
    externalConnectionId: string,
    action: () => Promise<Result>,
  ): Promise<Result> {
    return withAdvisoryLock(
      this.pool,
      providerConnectionLockKey(workspaceId, externalConnectionId),
      action,
    );
  }

  public async listEnabledConnections(
    workspaceId: string,
  ): Promise<ReconciliationConnectionTarget[]> {
    const result = await this.pool.query<TargetRow>(
      `select id, workspace_id, external_connection_id, local_status
       from provider_connection
       where workspace_id = $1 and provider = 'PLUGGY' and deleted_at is null
         and local_status not in ('DELETED', 'DISABLED')
       order by id`,
      [workspaceId],
    );
    return result.rows.map((row) => ({
      externalConnectionId: row.external_connection_id,
      localStatus: row.local_status,
      providerConnectionId: row.id,
      workspaceId: row.workspace_id,
    }));
  }

  public async isConnectionEnabled(
    workspaceId: string,
    providerConnectionId: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `select 1 from provider_connection
       where workspace_id = $1 and id = $2 and provider = 'PLUGGY'
         and deleted_at is null and local_status not in ('DELETED', 'DISABLED')
       limit 1`,
      [workspaceId, providerConnectionId],
    );
    return result.rowCount === 1;
  }

  public async markConnectionAttempted(
    workspaceId: string,
    providerConnectionId: string,
    attemptedAt = new Date(),
  ): Promise<void> {
    const result = await this.pool.query(
      `update provider_connection
       set last_attempt_at = $3, updated_at = $3
       where workspace_id = $1 and id = $2 and provider = 'PLUGGY'
         and deleted_at is null and local_status not in ('DELETED', 'DISABLED')
       returning id`,
      [workspaceId, providerConnectionId, attemptedAt],
    );
    if (result.rowCount !== 1) {
      throw new ReconciliationInvariantError('Reconciliation attempt update failed.');
    }
  }

  public async markConnectionSyncing(
    workspaceId: string,
    providerConnectionId: string,
    attemptedAt = new Date(),
  ): Promise<void> {
    const result = await this.pool.query(
      `update provider_connection
       set local_status = 'SYNCING', last_attempt_at = $3, updated_at = $3
       where workspace_id = $1 and id = $2 and provider = 'PLUGGY'
         and deleted_at is null and local_status not in ('DELETED', 'DISABLED')
       returning id`,
      [workspaceId, providerConnectionId, attemptedAt],
    );
    if (result.rowCount !== 1) {
      throw new ReconciliationInvariantError('Reconciliation connection update failed.');
    }
  }

  public async markConnectionSuccessful(
    workspaceId: string,
    providerConnectionId: string,
    successfulAt = new Date(),
  ): Promise<void> {
    const result = await this.pool.query(
      `update provider_connection
       set last_successful_sync_at = $3, updated_at = $3
       where workspace_id = $1 and id = $2 and provider = 'PLUGGY'
         and local_status not in ('DELETED', 'DISABLED')
       returning id`,
      [workspaceId, providerConnectionId, successfulAt],
    );
    if (result.rowCount !== 1) {
      throw new ReconciliationInvariantError('Reconciliation freshness update failed.');
    }
  }

  public async markConnectionDeleted(
    workspaceId: string,
    providerConnectionId: string,
    deletedAt = new Date(),
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(
        `update provider_connection
         set local_status = 'DELETED', deleted_at = coalesce(deleted_at, $3), updated_at = $3
         where workspace_id = $1 and id = $2 and provider = 'PLUGGY'
         returning id`,
        [workspaceId, providerConnectionId, deletedAt],
      );
      if (result.rowCount !== 1) {
        throw new ReconciliationInvariantError('Reconciliation connection deletion failed.');
      }
      await client.query(
        `update financial_account
         set is_active = false, updated_at = $3
         where workspace_id = $1 and provider_connection_id = $2 and provider = 'PLUGGY'`,
        [workspaceId, providerConnectionId, deletedAt],
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
        [workspaceId, providerConnectionId, deletedAt],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  public async recordActionEvidence(
    workspaceId: string,
    providerConnectionId: string,
    reconciliationRunId: string,
    localStatus:
      'PROVIDER_ERROR' | 'REAUTH_REQUIRED' | 'USER_ACTION_REQUIRED' | 'USER_INPUT_REQUIRED',
    createdAt = new Date(),
  ): Promise<void> {
    await this.pool.query(
      `insert into audit_event (
         workspace_id, actor_type, event_type, target_type, target_id, details, created_at
       )
       select $1, 'WORKER', 'SCHEDULED_RECONCILIATION_ACTION_REQUIRED',
         'PROVIDER_CONNECTION', $2, jsonb_build_object(
           'localStatus', $4::text, 'provider', 'PLUGGY',
           'reconciliationRunId', $3::text
         ), $5
       where not exists (
         select 1 from audit_event
         where workspace_id = $1
           and event_type = 'SCHEDULED_RECONCILIATION_ACTION_REQUIRED'
           and target_type = 'PROVIDER_CONNECTION' and target_id = $2
           and details ->> 'reconciliationRunId' = $3
       )`,
      [workspaceId, providerConnectionId, reconciliationRunId, localStatus, createdAt],
    );
  }
}
