import { randomUUID } from 'node:crypto';

import {
  RecurringSeriesConflictError,
  RecurringSeriesNotFoundError,
  type RecurringSeriesResult,
} from '@cashcount/db/finance';
import { z } from 'zod';

import { requireMcpReadOnlyCredential } from './mcp-readonly-auth.js';
import { requireWebOwnerCredential } from './web-owner-auth.js';

const uuidSchema = z.uuid();
const actorSchema = z.object({ actorId: z.string().trim().min(1).max(200) }).strict();

export interface RecurringRouteRepository {
  detect(workspaceId: string, actorId: string): Promise<{ candidateCount: number }>;
  list(workspaceId: string, includeInactive?: boolean): Promise<RecurringSeriesResult>;
  resolve(
    workspaceId: string,
    seriesId: string,
    actorId: string,
    status: 'CONFIRMED' | 'REJECTED',
  ): Promise<unknown>;
}

export interface RecurringRouteDependencies {
  mcpToken: string;
  now?: () => Date;
  repository: RecurringRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface RecurringRouteRequest {
  authorizationHeader: string | null;
  body: unknown;
  method: string;
  url: URL;
}

function problem(status: number, title: string, code: string, requestId: string) {
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

function dataJson(result: RecurringSeriesResult, includeIds: boolean) {
  const series = result.series.map((item) => ({
    amountAverage: { currency: item.currency, value: item.amountAverage },
    amountRange: {
      maximum: { currency: item.currency, value: item.amountMax },
      minimum: { currency: item.currency, value: item.amountMin },
    },
    cadence: item.cadence,
    confidence: item.confidence,
    expectedIntervalDays: item.expectedIntervalDays,
    ...(includeIds ? { id: item.id } : {}),
    lastOccurrenceDate: item.lastOccurrenceDate,
    merchantLabel: item.merchantLabel,
    nextExpectedDate: item.nextExpectedDate,
    observationCount: item.observationCount,
    priceChangePercent: item.priceChangePercent,
    status: item.status,
  }));
  return {
    monthlyBaseline: result.monthlyBaseline.map((item) => ({
      amount: { currency: item.currency, value: item.value },
    })),
    series: z.array(z.record(z.string(), z.unknown())).max(100).parse(series),
  };
}

export async function processRecurringRequest(
  request: RecurringRouteRequest,
  dependencies: RecurringRouteDependencies,
) {
  const isAnalytics = request.url.pathname === '/v1/analytics/recurring-expenses';
  const isReviewList = request.url.pathname === '/v1/recurring-series';
  const isDetect = request.url.pathname === '/v1/recurring-expenses/detect';
  const confirmMatch = /^\/v1\/recurring-series\/([^/]+)\/confirm$/u.exec(request.url.pathname);
  const rejectMatch = /^\/v1\/recurring-series\/([^/]+)\/reject$/u.exec(request.url.pathname);
  if (!isAnalytics && !isReviewList && !isDetect && confirmMatch === null && rejectMatch === null) {
    return null;
  }
  const requestId = dependencies.requestId?.() ?? randomUUID();
  if (!uuidSchema.safeParse(requestId).success) throw new TypeError('Invalid request ID.');
  if ([...request.url.searchParams].length > 0) {
    return problem(400, 'Query parameters are not allowed', 'INVALID_QUERY', requestId);
  }
  const webAuthorized = requireWebOwnerCredential(
    request.authorizationHeader,
    dependencies.webToken,
  );
  const mcpAuthorized = requireMcpReadOnlyCredential(
    request.authorizationHeader,
    dependencies.mcpToken,
  );
  if ((!isAnalytics && !webAuthorized) || (isAnalytics && !webAuthorized && !mcpAuthorized)) {
    return problem(401, 'Unauthorized', 'UNAUTHORIZED', requestId);
  }
  const expectedMethod = isAnalytics || isReviewList ? 'GET' : 'POST';
  if (request.method !== expectedMethod) {
    const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
    return { ...result, headers: { ...result.headers, allow: expectedMethod } };
  }
  try {
    if (isAnalytics || isReviewList) {
      if (request.body !== undefined) {
        return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
      }
      const result = await dependencies.repository.list(dependencies.workspaceId, isReviewList);
      const generatedAt = (dependencies.now?.() ?? new Date()).toISOString();
      return {
        body: {
          data: dataJson(result, isReviewList),
          freshness: {
            isStale: result.freshness.isStale,
            lastSuccessfulSyncAt: result.freshness.lastSuccessfulSyncAt?.toISOString() ?? null,
            oldestAccountSyncAt: result.freshness.oldestAccountSyncAt?.toISOString() ?? null,
            staleAfterMinutes: 1440,
          },
          meta: {
            generatedAt,
            policyVersion: result.policyVersion,
            requestId,
            workspaceId: dependencies.workspaceId,
          },
          warnings: result.warnings,
        },
        headers: { 'x-request-id': requestId },
        status: 200,
      };
    }
    const parsed = actorSchema.safeParse(request.body);
    if (!parsed.success) return problem(400, 'Invalid command', 'INVALID_COMMAND', requestId);
    if (isDetect) {
      const result = await dependencies.repository.detect(
        dependencies.workspaceId,
        parsed.data.actorId,
      );
      return {
        body: { data: result },
        headers: { 'x-request-id': requestId },
        status: 200,
      };
    }
    const match = confirmMatch ?? rejectMatch;
    const seriesId = match?.[1];
    if (seriesId === undefined || !uuidSchema.safeParse(seriesId).success) {
      return problem(400, 'Invalid series ID', 'INVALID_ID', requestId);
    }
    const status = confirmMatch === null ? 'REJECTED' : 'CONFIRMED';
    await dependencies.repository.resolve(
      dependencies.workspaceId,
      seriesId,
      parsed.data.actorId,
      status,
    );
    return {
      body: { data: { id: seriesId, status } },
      headers: { 'x-request-id': requestId },
      status: 200,
    };
  } catch (error) {
    if (error instanceof RecurringSeriesNotFoundError) {
      return problem(404, 'Recurring series not found', 'NOT_FOUND', requestId);
    }
    if (error instanceof RecurringSeriesConflictError) {
      return problem(409, 'Recurring series conflict', 'CONFLICT', requestId);
    }
    if (error instanceof TypeError) {
      return problem(400, 'Invalid recurring request', 'INVALID_REQUEST', requestId);
    }
    throw error;
  }
}
