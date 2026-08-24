import type { Pool } from 'pg';

import { insertQueueJob, type EnqueuedJob, type QueueJobType } from './job-queue-insert.js';

export interface OperationalSyncRun {
  accountsSeen: number;
  billsSeen: number;
  connectionDisplayName: string;
  connectionId: string;
  connectionStatus: string;
  errorSummary: null | string;
  finishedAt: Date | null;
  id: string;
  startedAt: Date;
  status: 'FAILED' | 'PARTIAL' | 'RUNNING' | 'SUCCEEDED';
  transactionsDeleted: number;
  transactionsInserted: number;
  transactionsSeen: number;
  transactionsUpdated: number;
  triggerType: 'INITIAL' | 'MANUAL' | 'RECOVERY' | 'SCHEDULED' | 'WEBHOOK';
}

export interface OperationalDeadLetter {
  attemptCount: number;
  availableAt: Date;
  createdAt: Date;
  finishedAt: Date;
  id: string;
  jobType: QueueJobType;
  lastErrorCode: null | string;
  lastErrorSummary: null | string;
  maxAttempts: number;
  startedAt: Date | null;
}

export interface RetriedOperationalJob {
  attemptCount: number;
  availableAt: Date;
  id: string;
  maxAttempts: number;
  status: 'RETRY';
}

export type RetryDeadLetterResult =
  | { outcome: 'ACTIVE_CONFLICT' | 'NOT_DEAD' | 'NOT_FOUND' | 'UNSUPPORTED' }
  | { job: RetriedOperationalJob; outcome: 'RETRIED' };

export type ManualReconciliationRequest =
  { outcome: 'CONNECTION_NOT_AVAILABLE' } | { job: EnqueuedJob; outcome: 'ENQUEUED' };

interface SyncRunRow {
  accounts_seen: number;
  bills_seen: number;
  connection_display_name: string;
  connection_id: string;
  connection_status: string;
  error_summary: null | string;
  finished_at: Date | null;
  id: string;
  started_at: Date;
  status: OperationalSyncRun['status'];
  transactions_deleted: number;
  transactions_inserted: number;
  transactions_seen: number;
  transactions_updated: number;
  trigger_type: OperationalSyncRun['triggerType'];
}

interface DeadLetterRow {
  attempt_count: number;
  available_at: Date;
  created_at: Date;
  finished_at: Date;
  id: string;
  job_type: QueueJobType;
  last_error_code: null | string;
  last_error_summary: null | string;
  max_attempts: number;
  started_at: Date | null;
}

interface RetryCandidateRow {
  attempt_count: number;
  dedupe_key: null | string;
  job_type: QueueJobType;
  max_attempts: number;
  status: string;
}

interface RetriedRow {
  attempt_count: number;
  available_at: Date;
  id: string;
  max_attempts: number;
  status: 'RETRY';
}

const retryableOperationalJobTypes = new Set<QueueJobType>(['PROCESS_WEBHOOK', 'SYNC_CONNECTION']);

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Operational list limit must be an integer from 1 to 100.');
  }
}

function syncRunRecord(row: SyncRunRow): OperationalSyncRun {
  return {
    accountsSeen: row.accounts_seen,
    billsSeen: row.bills_seen,
    connectionDisplayName: row.connection_display_name,
    connectionId: row.connection_id,
    connectionStatus: row.connection_status,
    errorSummary: row.error_summary,
    finishedAt: row.finished_at,
    id: row.id,
    startedAt: row.started_at,
    status: row.status,
    transactionsDeleted: row.transactions_deleted,
    transactionsInserted: row.transactions_inserted,
    transactionsSeen: row.transactions_seen,
    transactionsUpdated: row.transactions_updated,
    triggerType: row.trigger_type,
  };
}

function deadLetterRecord(row: DeadLetterRow): OperationalDeadLetter {
  return {
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    id: row.id,
    jobType: row.job_type,
    lastErrorCode: row.last_error_code,
    lastErrorSummary: row.last_error_summary,
    maxAttempts: row.max_attempts,
    startedAt: row.started_at,
  };
}

const syncRunColumns = `sr.id, sr.provider_connection_id as connection_id,
  pc.display_name as connection_display_name, pc.local_status as connection_status,
  sr.trigger_type, sr.status, sr.started_at, sr.finished_at, sr.accounts_seen,
  sr.transactions_seen, sr.transactions_inserted, sr.transactions_updated,
  sr.transactions_deleted, sr.bills_seen, sr.error_summary`;

const deadLetterColumns = `id, job_type, available_at, started_at, finished_at,
  attempt_count, max_attempts, last_error_code, last_error_summary, created_at`;

export class SyncOperationalRepository {
  public constructor(private readonly pool: Pool) {}

  public async listSyncRuns(workspaceId: string, limit = 50): Promise<OperationalSyncRun[]> {
    requireLimit(limit);
    const result = await this.pool.query<SyncRunRow>(
      `select ${syncRunColumns}
       from sync_run sr
       join provider_connection pc
         on pc.workspace_id = sr.workspace_id and pc.id = sr.provider_connection_id
       where sr.workspace_id = $1
       order by sr.started_at desc, sr.id desc
       limit $2`,
      [workspaceId, limit],
    );
    return result.rows.map(syncRunRecord);
  }

  public async getSyncRun(
    workspaceId: string,
    syncRunId: string,
  ): Promise<OperationalSyncRun | null> {
    const result = await this.pool.query<SyncRunRow>(
      `select ${syncRunColumns}
       from sync_run sr
       join provider_connection pc
         on pc.workspace_id = sr.workspace_id and pc.id = sr.provider_connection_id
       where sr.workspace_id = $1 and sr.id = $2
       limit 1`,
      [workspaceId, syncRunId],
    );
    const row = result.rows[0];
    return row === undefined ? null : syncRunRecord(row);
  }

  public async listDeadLetters(workspaceId: string, limit = 50): Promise<OperationalDeadLetter[]> {
    requireLimit(limit);
    const result = await this.pool.query<DeadLetterRow>(
      `select ${deadLetterColumns}
       from job_queue
       where workspace_id = $1 and status = 'DEAD'
       order by finished_at desc, id desc
       limit $2`,
      [workspaceId, limit],
    );
    return result.rows.map(deadLetterRecord);
  }

  public async requestManualReconciliation(
    workspaceId: string,
    providerConnectionId: string,
    requestedAt = new Date(),
  ): Promise<ManualReconciliationRequest> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const connection = await client.query(
        `select 1 from provider_connection
         where workspace_id = $1 and id = $2 and provider = 'PLUGGY'
           and deleted_at is null and local_status not in ('DELETED', 'DISABLED')
         for share`,
        [workspaceId, providerConnectionId],
      );
      if (connection.rowCount !== 1) {
        await client.query('rollback');
        return { outcome: 'CONNECTION_NOT_AVAILABLE' };
      }
      const job = await insertQueueJob(client, workspaceId, {
        availableAt: requestedAt,
        dedupeKey: `manual-reconcile:${providerConnectionId}`,
        jobType: 'SYNC_CONNECTION',
        maxAttempts: 8,
        payload: { providerConnectionId },
        priority: 100,
      });
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details, created_at
         ) values ($1, 'SYSTEM', 'service_web', 'MANUAL_RECONCILIATION_REQUESTED',
           'PROVIDER_CONNECTION', $2, jsonb_build_object('jobId', $3::text, 'created', $4::boolean), $5)`,
        [workspaceId, providerConnectionId, job.id, job.created, requestedAt],
      );
      await client.query('commit');
      return { job, outcome: 'ENQUEUED' };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  public async retryDeadLetter(
    workspaceId: string,
    jobId: string,
    requestedAt = new Date(),
  ): Promise<RetryDeadLetterResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const selected = await client.query<RetryCandidateRow>(
        `select status, job_type, dedupe_key, attempt_count, max_attempts
         from job_queue where workspace_id = $1 and id = $2 for update`,
        [workspaceId, jobId],
      );
      const row = selected.rows[0];
      if (row === undefined) {
        await client.query('rollback');
        return { outcome: 'NOT_FOUND' };
      }
      if (row.status !== 'DEAD') {
        await client.query('rollback');
        return { outcome: 'NOT_DEAD' };
      }
      if (!retryableOperationalJobTypes.has(row.job_type)) {
        await client.query('rollback');
        return { outcome: 'UNSUPPORTED' };
      }
      if (row.dedupe_key !== null) {
        const active = await client.query(
          `select 1 from job_queue
           where workspace_id = $1 and id <> $2 and job_type = $3 and dedupe_key = $4
             and status in ('PENDING', 'RETRY', 'RUNNING')
           limit 1`,
          [workspaceId, jobId, row.job_type, row.dedupe_key],
        );
        if (active.rowCount === 1) {
          await client.query('rollback');
          return { outcome: 'ACTIVE_CONFLICT' };
        }
      }
      const retried = await client.query<RetriedRow>(
        `update job_queue
         set status = 'RETRY', available_at = $3, finished_at = null,
             max_attempts = greatest(max_attempts, attempt_count + 1),
             locked_at = null, locked_by = null, heartbeat_at = null, lease_expires_at = null,
             updated_at = $3
         where workspace_id = $1 and id = $2 and status = 'DEAD'
         returning id, status, available_at, attempt_count, max_attempts`,
        [workspaceId, jobId, requestedAt],
      );
      const retriedRow = retried.rows[0];
      if (retriedRow === undefined) throw new Error('Dead-letter retry lost its locked job.');
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details, created_at
         ) values ($1, 'SYSTEM', 'service_web', 'DEAD_LETTER_RETRIED', 'JOB_QUEUE', $2,
           jsonb_build_object('attemptCount', $3::integer, 'maxAttempts', $4::integer), $5)`,
        [workspaceId, jobId, retriedRow.attempt_count, retriedRow.max_attempts, requestedAt],
      );
      await client.query('commit');
      return {
        job: {
          attemptCount: retriedRow.attempt_count,
          availableAt: retriedRow.available_at,
          id: retriedRow.id,
          maxAttempts: retriedRow.max_attempts,
          status: retriedRow.status,
        },
        outcome: 'RETRIED',
      };
    } catch (error) {
      await client.query('rollback');
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        return { outcome: 'ACTIVE_CONFLICT' };
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
