import type { Pool } from 'pg';

import {
  insertQueueJob,
  queueJobTypes,
  type EnqueuedJob,
  type EnqueueJobInput,
  type QueueJobPayload,
  type QueueJobType,
} from './job-queue-insert.js';

export const defaultQueueLeaseMs = 120_000;
export const defaultQueueHeartbeatMs = 30_000;

const queueWorkerCapabilityBrand: unique symbol = Symbol('cashcount.queue-worker');
const systemQueueCapabilityBrand: unique symbol = Symbol('cashcount.system-queue');

export interface QueueWorkerCapability {
  readonly [queueWorkerCapabilityBrand]: true;
}

export interface SystemQueueCapability {
  readonly [systemQueueCapabilityBrand]: true;
}

export const queueWorkerCapability: QueueWorkerCapability = Object.freeze({
  [queueWorkerCapabilityBrand]: true as const,
});
export const systemQueueCapability: SystemQueueCapability = Object.freeze({
  [systemQueueCapabilityBrand]: true as const,
});

export type QueueJobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'RETRY' | 'DEAD';

export interface ClaimedQueueJob {
  attemptCount: number;
  availableAt: Date;
  dedupeKey: null | string;
  heartbeatAt: Date;
  id: string;
  jobType: QueueJobType;
  leaseExpiresAt: Date;
  maxAttempts: number;
  payload: QueueJobPayload;
  priority: number;
  startedAt: Date;
  status: 'RUNNING';
  workspaceId: null | string;
}

export interface ClaimQueueJobInput {
  jobTypes?: readonly QueueJobType[];
  leaseDurationMs?: number;
  now: Date;
  workerId: string;
}

export interface FailQueueJobInput {
  errorCode: string;
  jobId: string;
  now: Date;
  redactedSummary: string;
  retryAt: Date | null;
  workerId: string;
}

export interface ReclaimExpiredQueueJobsInput {
  limit?: number;
  now: Date;
  retryAtForAttempt?: (attemptCount: number) => Date;
}

export interface ReclaimedQueueJob {
  attemptCount: number;
  id: string;
  status: 'RETRY' | 'DEAD';
}

interface ClaimedQueueRow {
  attempt_count: number;
  available_at: Date;
  dedupe_key: null | string;
  heartbeat_at: Date;
  id: string;
  job_type: QueueJobType;
  lease_expires_at: Date;
  max_attempts: number;
  payload: QueueJobPayload;
  priority: number;
  started_at: Date;
  status: 'RUNNING';
  workspace_id: null | string;
}

interface ExpiredQueueRow {
  attempt_count: number;
  id: string;
  max_attempts: number;
}

interface ReclaimedQueueRow {
  attempt_count: number;
  id: string;
  status: 'RETRY' | 'DEAD';
}

export class QueueLeaseLostError extends Error {
  public constructor(public readonly jobId: string) {
    super('Queue job is not owned with an unexpired lease.');
    this.name = 'QueueLeaseLostError';
  }
}

function requireWorkerCapability(capability: QueueWorkerCapability): void {
  if (capability !== queueWorkerCapability) {
    throw new TypeError('Queue worker capability is required.');
  }
}

function requireSystemCapability(capability: SystemQueueCapability): void {
  if (capability !== systemQueueCapability) {
    throw new TypeError('System queue capability is required.');
  }
}

function requireInstant(name: string, value: Date): void {
  if (!Number.isFinite(value.getTime())) throw new TypeError(`${name} must be a valid instant.`);
}

function requireWorkerId(workerId: string): void {
  if (workerId.trim() !== workerId || workerId.length === 0 || workerId.length > 200) {
    throw new TypeError('workerId must contain 1 to 200 trimmed characters.');
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function leaseExpiry(now: Date, durationMs = defaultQueueLeaseMs): Date {
  requireInstant('now', now);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1_000 || durationMs > 900_000) {
    throw new TypeError('leaseDurationMs must be an integer from 1000 to 900000.');
  }
  return new Date(now.getTime() + durationMs);
}

function validateFailure(input: FailQueueJobInput): void {
  requireWorkerId(input.workerId);
  requireInstant('now', input.now);
  if (!/^[A-Z][A-Z0-9_]{0,99}$/u.test(input.errorCode)) {
    throw new TypeError('errorCode must be a bounded uppercase machine code.');
  }
  if (
    input.redactedSummary.trim() !== input.redactedSummary ||
    input.redactedSummary.length === 0 ||
    input.redactedSummary.length > 1_000 ||
    containsControlCharacter(input.redactedSummary)
  ) {
    throw new TypeError('redactedSummary must contain 1 to 1000 safe characters.');
  }
  if (input.retryAt !== null) {
    requireInstant('retryAt', input.retryAt);
    if (input.retryAt < input.now) throw new TypeError('retryAt cannot precede now.');
  }
}

function claimedJob(row: ClaimedQueueRow): ClaimedQueueJob {
  return {
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    dedupeKey: row.dedupe_key,
    heartbeatAt: row.heartbeat_at,
    id: row.id,
    jobType: row.job_type,
    leaseExpiresAt: row.lease_expires_at,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    priority: row.priority,
    startedAt: row.started_at,
    status: row.status,
    workspaceId: row.workspace_id,
  };
}

function defaultReclaimRetryAt(now: Date, attemptCount: number): Date {
  const backoffMs = Math.min(300_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
  return new Date(now.getTime() + backoffMs);
}

export class JobQueueRepository {
  public constructor(private readonly pool: Pool) {}

  public enqueueWorkspace(workspaceId: string, input: EnqueueJobInput): Promise<EnqueuedJob> {
    return insertQueueJob(this.pool, workspaceId, input);
  }

  public enqueueSystem(
    capability: SystemQueueCapability,
    input: EnqueueJobInput,
  ): Promise<EnqueuedJob> {
    requireSystemCapability(capability);
    return insertQueueJob(this.pool, null, input);
  }

  public async claim(
    capability: QueueWorkerCapability,
    input: ClaimQueueJobInput,
  ): Promise<ClaimedQueueJob | null> {
    requireWorkerCapability(capability);
    requireWorkerId(input.workerId);
    if (input.jobTypes !== undefined) {
      if (
        input.jobTypes.length === 0 ||
        input.jobTypes.some((jobType) => !queueJobTypes.includes(jobType))
      ) {
        throw new TypeError('jobTypes must contain one or more supported queue job types.');
      }
    }
    const expiresAt = leaseExpiry(input.now, input.leaseDurationMs);
    const result = await this.pool.query<ClaimedQueueRow>(
      `with candidate as (
         select id
         from job_queue
         where status in ('PENDING', 'RETRY')
           and available_at <= $1::timestamptz
           and attempt_count < max_attempts
           and ($4::text[] is null or job_type = any($4::text[]))
         order by priority desc, created_at, id
         for update skip locked
         limit 1
       )
       update job_queue job
       set status = 'RUNNING',
           locked_at = $1::timestamptz,
           locked_by = $2,
           started_at = coalesce(job.started_at, $1::timestamptz),
           heartbeat_at = $1::timestamptz,
           lease_expires_at = $3::timestamptz,
           finished_at = null,
           attempt_count = job.attempt_count + 1,
           updated_at = $1::timestamptz
       from candidate
       where job.id = candidate.id
       returning job.id, job.workspace_id, job.job_type, job.payload, job.dedupe_key,
                 job.status, job.priority, job.available_at, job.started_at, job.heartbeat_at,
                 job.lease_expires_at, job.attempt_count, job.max_attempts`,
      [input.now, input.workerId, expiresAt, input.jobTypes ?? null],
    );
    const row = result.rows[0];
    return row === undefined ? null : claimedJob(row);
  }

  public async heartbeat(
    capability: QueueWorkerCapability,
    jobId: string,
    workerId: string,
    now: Date,
    leaseDurationMs = defaultQueueLeaseMs,
  ): Promise<Date> {
    requireWorkerCapability(capability);
    requireWorkerId(workerId);
    const expiresAt = leaseExpiry(now, leaseDurationMs);
    const result = await this.pool.query<{ lease_expires_at: Date }>(
      `update job_queue
       set heartbeat_at = $3::timestamptz,
           lease_expires_at = $4::timestamptz,
           updated_at = $3::timestamptz
       where id = $1::uuid and status = 'RUNNING' and locked_by = $2
         and lease_expires_at > $3::timestamptz
       returning lease_expires_at`,
      [jobId, workerId, now, expiresAt],
    );
    const row = result.rows[0];
    if (row === undefined) throw new QueueLeaseLostError(jobId);
    return row.lease_expires_at;
  }

  public async complete(
    capability: QueueWorkerCapability,
    jobId: string,
    workerId: string,
    now: Date,
  ): Promise<void> {
    requireWorkerCapability(capability);
    requireWorkerId(workerId);
    requireInstant('now', now);
    const result = await this.pool.query(
      `update job_queue
       set status = 'SUCCEEDED', finished_at = $3::timestamptz,
           locked_at = null, locked_by = null, heartbeat_at = null, lease_expires_at = null,
           updated_at = $3::timestamptz
       where id = $1::uuid and status = 'RUNNING' and locked_by = $2
         and lease_expires_at > $3::timestamptz
       returning id`,
      [jobId, workerId, now],
    );
    if (result.rowCount !== 1) throw new QueueLeaseLostError(jobId);
  }

  public async fail(
    capability: QueueWorkerCapability,
    input: FailQueueJobInput,
  ): Promise<'RETRY' | 'DEAD'> {
    requireWorkerCapability(capability);
    validateFailure(input);
    const result = await this.pool.query<{ status: 'RETRY' | 'DEAD' }>(
      `update job_queue
       set status = case
             when $4::timestamptz is not null and attempt_count < max_attempts then 'RETRY'
             else 'DEAD'
           end,
           available_at = case
             when $4::timestamptz is not null and attempt_count < max_attempts then $4::timestamptz
             else available_at
           end,
           finished_at = case
             when $4::timestamptz is not null and attempt_count < max_attempts then null
             else $3::timestamptz
           end,
           locked_at = null, locked_by = null, heartbeat_at = null, lease_expires_at = null,
           last_error_code = $5, last_error_summary = $6, updated_at = $3::timestamptz
       where id = $1::uuid and status = 'RUNNING' and locked_by = $2
         and lease_expires_at > $3::timestamptz
       returning status`,
      [
        input.jobId,
        input.workerId,
        input.now,
        input.retryAt,
        input.errorCode,
        input.redactedSummary,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new QueueLeaseLostError(input.jobId);
    return row.status;
  }

  public async reclaimExpired(
    capability: QueueWorkerCapability,
    input: ReclaimExpiredQueueJobsInput,
  ): Promise<ReclaimedQueueJob[]> {
    requireWorkerCapability(capability);
    requireInstant('now', input.now);
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('reclaim limit must be an integer from 1 to 1000.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const expired = await client.query<ExpiredQueueRow>(
        `select id, attempt_count, max_attempts
         from job_queue
         where status = 'RUNNING' and lease_expires_at <= $1::timestamptz
         order by lease_expires_at, id
         for update skip locked
         limit $2`,
        [input.now, limit],
      );
      const reclaimed: ReclaimedQueueJob[] = [];
      for (const row of expired.rows) {
        const dead = row.attempt_count >= row.max_attempts;
        const retryAt = dead
          ? input.now
          : (input.retryAtForAttempt ?? ((attempt) => defaultReclaimRetryAt(input.now, attempt)))(
              row.attempt_count,
            );
        requireInstant('reclaim retryAt', retryAt);
        if (retryAt < input.now) throw new TypeError('reclaim retryAt cannot precede now.');
        const updated = await client.query<ReclaimedQueueRow>(
          `update job_queue
           set status = $2,
               available_at = case when $2 = 'RETRY' then $3::timestamptz else available_at end,
               finished_at = case when $2 = 'DEAD' then $1::timestamptz else null end,
               locked_at = null, locked_by = null, heartbeat_at = null, lease_expires_at = null,
               last_error_code = 'LEASE_EXPIRED',
               last_error_summary = 'Worker lease expired before completion.',
               updated_at = $1::timestamptz
           where id = $4::uuid and status = 'RUNNING'
           returning id, status, attempt_count`,
          [input.now, dead ? 'DEAD' : 'RETRY', retryAt, row.id],
        );
        const updatedRow = updated.rows[0];
        if (updatedRow !== undefined) {
          reclaimed.push({
            attemptCount: updatedRow.attempt_count,
            id: updatedRow.id,
            status: updatedRow.status,
          });
        }
      }
      await client.query('commit');
      return reclaimed;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
