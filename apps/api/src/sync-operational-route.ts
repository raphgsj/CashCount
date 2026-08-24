import { randomUUID } from 'node:crypto';

import type {
  ManualReconciliationRequest,
  OperationalDeadLetter,
  OperationalSyncRun,
  RetryDeadLetterResult,
} from '@cashcount/db/operational';
import { z } from 'zod';

import { requireWebOwnerCredential } from './web-owner-auth.js';

const canonicalUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const isoInstantSchema = z.iso.datetime({ offset: true });
const syncRunSchema = z.object({
  accountsSeen: z.number().int().nonnegative(),
  billsSeen: z.number().int().nonnegative(),
  connectionDisplayName: z.string().min(1),
  connectionId: canonicalUuidSchema,
  connectionStatus: z.string().min(1),
  errorSummary: z.string().max(1_000).nullable(),
  finishedAt: isoInstantSchema.nullable(),
  id: canonicalUuidSchema,
  startedAt: isoInstantSchema,
  status: z.enum(['RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED']),
  transactionsDeleted: z.number().int().nonnegative(),
  transactionsInserted: z.number().int().nonnegative(),
  transactionsSeen: z.number().int().nonnegative(),
  transactionsUpdated: z.number().int().nonnegative(),
  triggerType: z.enum(['INITIAL', 'WEBHOOK', 'MANUAL', 'SCHEDULED', 'RECOVERY']),
});
const deadLetterSchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  availableAt: isoInstantSchema,
  createdAt: isoInstantSchema,
  finishedAt: isoInstantSchema,
  id: canonicalUuidSchema,
  jobType: z.string().min(1),
  lastErrorCode: z.string().max(100).nullable(),
  lastErrorSummary: z.string().max(1_000).nullable(),
  maxAttempts: z.number().int().positive(),
  startedAt: isoInstantSchema.nullable(),
});
const enqueuedCommandSchema = z.object({
  created: z.boolean(),
  id: canonicalUuidSchema,
  status: z.enum(['PENDING', 'RETRY', 'RUNNING']),
});
const retriedCommandSchema = z.object({
  attemptCount: z.number().int().nonnegative(),
  availableAt: isoInstantSchema,
  id: canonicalUuidSchema,
  maxAttempts: z.number().int().positive(),
  status: z.literal('RETRY'),
});

export interface SyncOperationalRouteRepository {
  getSyncRun(workspaceId: string, syncRunId: string): Promise<OperationalSyncRun | null>;
  listDeadLetters(workspaceId: string, limit?: number): Promise<OperationalDeadLetter[]>;
  listSyncRuns(workspaceId: string, limit?: number): Promise<OperationalSyncRun[]>;
  requestManualReconciliation(
    workspaceId: string,
    providerConnectionId: string,
    requestedAt?: Date,
  ): Promise<ManualReconciliationRequest>;
  retryDeadLetter(
    workspaceId: string,
    jobId: string,
    requestedAt?: Date,
  ): Promise<RetryDeadLetterResult>;
}

export interface SyncOperationalRouteDependencies {
  now?: () => Date;
  repository: SyncOperationalRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface SyncOperationalRouteRequest {
  authorizationHeader: null | string;
  hasBody: boolean;
  invalidContentLength?: boolean;
  method: string;
  url: URL;
}

export interface SyncOperationalRouteResult {
  body: unknown;
  headers: Readonly<Record<string, string>>;
  status: number;
}

interface ResponseMeta {
  generatedAt: string;
  requestId: string;
  workspaceId: string;
}

function meta(
  dependencies: SyncOperationalRouteDependencies,
  requestId: string,
  generatedAt: Date,
): ResponseMeta {
  return {
    generatedAt: generatedAt.toISOString(),
    requestId,
    workspaceId: dependencies.workspaceId,
  };
}

function problem(
  status: number,
  title: string,
  code: string,
  requestId: string,
): SyncOperationalRouteResult {
  return {
    body: {
      code,
      requestId,
      status,
      title,
      type: `https://cashcount.invalid/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    },
    headers: { 'x-request-id': requestId },
    status,
  };
}

function parseLimit(searchParams: URLSearchParams): number | null {
  const keys = [...searchParams.keys()];
  if (keys.some((key) => key !== 'limit') || searchParams.getAll('limit').length > 1) return null;
  const raw = searchParams.get('limit');
  if (raw === null) return 50;
  if (!/^[1-9]\d*$/u.test(raw)) return null;
  const limit = Number(raw);
  return Number.isSafeInteger(limit) && limit <= 100 ? limit : null;
}

function syncRunJson(record: OperationalSyncRun): z.input<typeof syncRunSchema> {
  return {
    ...record,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    startedAt: record.startedAt.toISOString(),
  };
}

function deadLetterJson(record: OperationalDeadLetter): z.input<typeof deadLetterSchema> {
  return {
    ...record,
    availableAt: record.availableAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    finishedAt: record.finishedAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
  };
}

function methodNotAllowed(requestId: string, allow: string): SyncOperationalRouteResult {
  const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
  return { ...result, headers: { ...result.headers, allow } };
}

function commandResponse(
  data: unknown,
  responseMeta: ResponseMeta,
  requestId: string,
): SyncOperationalRouteResult {
  return {
    body: { data, meta: responseMeta },
    headers: { 'x-request-id': requestId },
    status: 202,
  };
}

export async function processSyncOperationalRequest(
  request: SyncOperationalRouteRequest,
  dependencies: SyncOperationalRouteDependencies,
): Promise<SyncOperationalRouteResult | null> {
  const path = request.url.pathname;
  const syncRunDetail = /^\/v1\/sync-runs\/([^/]+)$/u.exec(path);
  const retryJob = /^\/v1\/jobs\/([^/]+)\/retry$/u.exec(path);
  const reconcileConnection = /^\/v1\/connections\/([^/]+)\/reconcile$/u.exec(path);
  const recognized =
    path === '/v1/sync-runs' ||
    path === '/v1/jobs/dead-letter' ||
    syncRunDetail !== null ||
    retryJob !== null ||
    reconcileConnection !== null;
  if (!recognized) return null;

  const requestId = dependencies.requestId?.() ?? randomUUID();
  if (!canonicalUuidSchema.safeParse(requestId).success) {
    throw new TypeError('Operational request IDs must be canonical UUIDs.');
  }
  if (!requireWebOwnerCredential(request.authorizationHeader, dependencies.webToken)) {
    return problem(401, 'Unauthorized', 'UNAUTHORIZED', requestId);
  }
  if (request.invalidContentLength === true) {
    return problem(400, 'Invalid Content-Length', 'INVALID_CONTENT_LENGTH', requestId);
  }
  if (request.hasBody)
    return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
  const generatedAt = dependencies.now?.() ?? new Date();
  const responseMeta = meta(dependencies, requestId, generatedAt);
  if (
    path !== '/v1/sync-runs' &&
    path !== '/v1/jobs/dead-letter' &&
    request.url.searchParams.size > 0
  ) {
    return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
  }

  if (path === '/v1/sync-runs') {
    if (request.method !== 'GET') return methodNotAllowed(requestId, 'GET');
    const limit = parseLimit(request.url.searchParams);
    if (limit === null) return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
    const records = await dependencies.repository.listSyncRuns(dependencies.workspaceId, limit);
    const items = z.array(syncRunSchema).parse(records.map(syncRunJson));
    return {
      body: { data: { items, limit }, meta: responseMeta },
      headers: { 'x-request-id': requestId },
      status: 200,
    };
  }

  if (path === '/v1/jobs/dead-letter') {
    if (request.method !== 'GET') return methodNotAllowed(requestId, 'GET');
    const limit = parseLimit(request.url.searchParams);
    if (limit === null) return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
    const records = await dependencies.repository.listDeadLetters(dependencies.workspaceId, limit);
    const items = z.array(deadLetterSchema).parse(records.map(deadLetterJson));
    return {
      body: { data: { items, limit }, meta: responseMeta },
      headers: { 'x-request-id': requestId },
      status: 200,
    };
  }

  if (syncRunDetail !== null) {
    if (request.method !== 'GET') return methodNotAllowed(requestId, 'GET');
    const parsedId = canonicalUuidSchema.safeParse(syncRunDetail[1]);
    if (!parsedId.success) return problem(400, 'Invalid sync run ID', 'INVALID_ID', requestId);
    const record = await dependencies.repository.getSyncRun(
      dependencies.workspaceId,
      parsedId.data,
    );
    if (record === null) return problem(404, 'Sync run not found', 'NOT_FOUND', requestId);
    const data = syncRunSchema.parse(syncRunJson(record));
    return {
      body: { data, meta: responseMeta },
      headers: { 'x-request-id': requestId },
      status: 200,
    };
  }

  if (retryJob !== null) {
    if (request.method !== 'POST') return methodNotAllowed(requestId, 'POST');
    const parsedId = canonicalUuidSchema.safeParse(retryJob[1]);
    if (!parsedId.success) return problem(400, 'Invalid job ID', 'INVALID_ID', requestId);
    const result = await dependencies.repository.retryDeadLetter(
      dependencies.workspaceId,
      parsedId.data,
      generatedAt,
    );
    if (result.outcome === 'NOT_FOUND') {
      return problem(404, 'Dead-letter job not found', 'NOT_FOUND', requestId);
    }
    if (result.outcome !== 'RETRIED') {
      return problem(409, 'Dead-letter job cannot be retried', result.outcome, requestId);
    }
    return commandResponse(
      retriedCommandSchema.parse({
        ...result.job,
        availableAt: result.job.availableAt.toISOString(),
      }),
      responseMeta,
      requestId,
    );
  }

  if (reconcileConnection !== null) {
    if (request.method !== 'POST') return methodNotAllowed(requestId, 'POST');
    const parsedId = canonicalUuidSchema.safeParse(reconcileConnection[1]);
    if (!parsedId.success) return problem(400, 'Invalid connection ID', 'INVALID_ID', requestId);
    const result = await dependencies.repository.requestManualReconciliation(
      dependencies.workspaceId,
      parsedId.data,
      generatedAt,
    );
    if (result.outcome === 'CONNECTION_NOT_AVAILABLE') {
      return problem(404, 'Connection not available', 'NOT_FOUND', requestId);
    }
    return commandResponse(
      enqueuedCommandSchema.parse({
        created: result.job.created,
        id: result.job.id,
        status: result.job.status,
      }),
      responseMeta,
      requestId,
    );
  }

  return null;
}
