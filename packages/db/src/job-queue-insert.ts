import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

import type { Pool, PoolClient } from 'pg';

export const queueJobTypes = [
  'PROCESS_WEBHOOK',
  'DISCOVER_CONNECTIONS',
  'SYNC_CONNECTION',
  'SYNC_ACCOUNT',
  'SYNC_TRANSACTIONS_PAGE',
  'SYNC_BILLS',
  'NORMALIZE_TRANSACTION',
  'RESOLVE_MERCHANT',
  'CLASSIFY_TRANSACTION',
  'REBUILD_RECURRING_SERIES',
  'REBUILD_INSTALLMENT_SERIES',
  'RECOMPUTE_ANALYTICS_CACHE',
  'REPROCESS_RAW_OBJECT',
] as const;

export type QueueJobType = (typeof queueJobTypes)[number];
export type QueueJobPayload = Readonly<Record<string, string | readonly string[]>>;

export interface EnqueueJobInput {
  availableAt?: Date;
  dedupeKey?: string;
  jobType: QueueJobType;
  maxAttempts: number;
  payload?: QueueJobPayload;
  priority?: number;
}

export interface EnqueuedJob {
  attemptCount: number;
  availableAt: Date;
  created: boolean;
  dedupeKey: null | string;
  id: string;
  jobType: QueueJobType;
  maxAttempts: number;
  payload: QueueJobPayload;
  priority: number;
  status: 'PENDING' | 'RETRY' | 'RUNNING';
  workspaceId: null | string;
}

interface QueueInsertRow {
  attempt_count: number;
  available_at: Date;
  dedupe_key: null | string;
  id: string;
  job_type: QueueJobType;
  max_attempts: number;
  payload: QueueJobPayload;
  priority: number;
  status: 'PENDING' | 'RETRY' | 'RUNNING';
  workspace_id: null | string;
}

type QueueQueryable = Pick<Pool | PoolClient, 'query'>;

const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const internalIdKeyPattern = /^[a-z][A-Za-z0-9]*(?:Id|Ids)$/u;
const queueJobTypeSet = new Set<string>(queueJobTypes);

function requireDate(name: string, value: Date): void {
  if (!Number.isFinite(value.getTime())) throw new TypeError(`${name} must be a valid instant.`);
}

function validatePayload(payload: QueueJobPayload): void {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > 16_384) {
    throw new TypeError('Queue payload must be at most 16384 bytes.');
  }

  for (const [key, value] of Object.entries(payload)) {
    if (!internalIdKeyPattern.test(key)) {
      throw new TypeError('Queue payload keys must name internal Id or Ids references.');
    }
    const values = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(values) || values.length === 0 || values.length > 500) {
      throw new TypeError('Queue payload references must be one UUID or 1 to 500 UUIDs.');
    }
    if (values.some((entry) => typeof entry !== 'string' || !canonicalUuidPattern.test(entry))) {
      throw new TypeError('Queue payload references must be canonical internal UUIDs.');
    }
  }
}

function validateEnqueue(workspaceId: null | string, input: EnqueueJobInput): void {
  if (workspaceId !== null && !canonicalUuidPattern.test(workspaceId)) {
    throw new TypeError('workspaceId must be a canonical UUID.');
  }
  if (!queueJobTypeSet.has(input.jobType)) throw new TypeError('Unsupported queue job type.');
  if (
    !Number.isSafeInteger(input.maxAttempts) ||
    input.maxAttempts < 1 ||
    input.maxAttempts > 100
  ) {
    throw new TypeError('maxAttempts must be an integer from 1 to 100.');
  }
  const priority = input.priority ?? 0;
  if (!Number.isSafeInteger(priority) || priority < -1_000_000 || priority > 1_000_000) {
    throw new TypeError('priority must be an integer from -1000000 to 1000000.');
  }
  if (input.availableAt !== undefined) requireDate('availableAt', input.availableAt);
  if (
    input.dedupeKey !== undefined &&
    (input.dedupeKey.trim() !== input.dedupeKey ||
      input.dedupeKey.length === 0 ||
      input.dedupeKey.length > 500)
  ) {
    throw new TypeError('dedupeKey must contain 1 to 500 trimmed characters.');
  }
  validatePayload(input.payload ?? {});
}

function queueRow(row: QueueInsertRow, created: boolean): EnqueuedJob {
  return {
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    created,
    dedupeKey: row.dedupe_key,
    id: row.id,
    jobType: row.job_type,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    priority: row.priority,
    status: row.status,
    workspaceId: row.workspace_id,
  };
}

const returnedColumns = `id, workspace_id, job_type, payload, dedupe_key, status,
  priority, available_at, attempt_count, max_attempts`;

export async function insertQueueJob(
  queryable: QueueQueryable,
  workspaceId: null | string,
  input: EnqueueJobInput,
): Promise<EnqueuedJob> {
  validateEnqueue(workspaceId, input);
  const id = randomUUID();
  const payload = input.payload ?? {};
  const inserted = await queryable.query<QueueInsertRow>(
    `insert into job_queue (
       id, workspace_id, job_type, payload, dedupe_key, priority, available_at, max_attempts
     ) values ($1::uuid, $2::uuid, $3, $4::jsonb, $5, $6, $7::timestamptz, $8)
     on conflict do nothing
     returning ${returnedColumns}`,
    [
      id,
      workspaceId,
      input.jobType,
      JSON.stringify(payload),
      input.dedupeKey ?? null,
      input.priority ?? 0,
      input.availableAt ?? new Date(),
      input.maxAttempts,
    ],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow !== undefined) return queueRow(insertedRow, true);

  if (input.dedupeKey === undefined) {
    throw new Error('Queue insert conflicted without an active dedupe key.');
  }
  const existing = await queryable.query<QueueInsertRow>(
    `select ${returnedColumns}
     from job_queue
     where workspace_id is not distinct from $1::uuid
       and job_type = $2
       and dedupe_key = $3
       and status in ('PENDING', 'RETRY', 'RUNNING')
     limit 1`,
    [workspaceId, input.jobType, input.dedupeKey],
  );
  const existingRow = existing.rows[0];
  if (existingRow === undefined) {
    throw new Error('Active queue dedupe conflict could not be resolved.');
  }
  return queueRow(existingRow, false);
}
