import { randomUUID } from 'node:crypto';

import {
  AnalyticsWorkspaceNotFoundError,
  type SpendingCashFlowInput,
  type SpendingCashFlowResult,
} from '@cashcount/analytics';
import {
  analyticsFreshnessSchema,
  spendingCashFlowDataSchema,
  spendingCashFlowWarningSchema,
} from '@cashcount/contracts';
import { z } from 'zod';

import { requireMcpReadOnlyCredential } from './mcp-readonly-auth.js';
import { requireWebOwnerCredential } from './web-owner-auth.js';

const canonicalUuidSchema = z.uuid();
const dateSchema = z.iso.date();
const allowedQueryKeys = new Set([
  'accountId',
  'categoryId',
  'from',
  'granularity',
  'includePending',
  'merchantId',
  'to',
]);

export interface AnalyticsRouteRepository {
  summarize(workspaceId: string, input: SpendingCashFlowInput): Promise<SpendingCashFlowResult>;
}

export interface AnalyticsRouteDependencies {
  mcpToken: string;
  now?: () => Date;
  repository: AnalyticsRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface AnalyticsRouteRequest {
  authorizationHeader: null | string;
  hasBody: boolean;
  method: string;
  url: URL;
}

export interface AnalyticsRouteResult {
  body: unknown;
  headers: Readonly<Record<string, string>>;
  status: number;
}

function problem(
  status: number,
  title: string,
  code: string,
  requestId: string,
): AnalyticsRouteResult {
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

function parseQuery(searchParams: URLSearchParams): SpendingCashFlowInput | null {
  if ([...searchParams.keys()].some((key) => !allowedQueryKeys.has(key))) return null;
  if ([...allowedQueryKeys].some((key) => searchParams.getAll(key).length > 1)) return null;
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  if (from === null || to === null) return null;
  if (!dateSchema.safeParse(from).success || !dateSchema.safeParse(to).success) return null;
  const accountId = searchParams.get('accountId');
  const categoryId = searchParams.get('categoryId');
  const merchantId = searchParams.get('merchantId');
  for (const id of [accountId, categoryId, merchantId]) {
    if (id !== null && !canonicalUuidSchema.safeParse(id).success) return null;
  }
  const includePendingRaw = searchParams.get('includePending');
  if (includePendingRaw !== null && includePendingRaw !== 'true' && includePendingRaw !== 'false') {
    return null;
  }
  const granularityRaw = searchParams.get('granularity');
  if (
    granularityRaw !== null &&
    granularityRaw !== 'DAY' &&
    granularityRaw !== 'WEEK' &&
    granularityRaw !== 'MONTH'
  ) {
    return null;
  }
  return {
    ...(accountId === null ? {} : { accountId }),
    ...(categoryId === null ? {} : { categoryId }),
    from,
    ...(granularityRaw === null ? {} : { granularity: granularityRaw }),
    ...(includePendingRaw === null ? {} : { includePending: includePendingRaw === 'true' }),
    ...(merchantId === null ? {} : { merchantId }),
    to,
  };
}

function dataJson(result: SpendingCashFlowResult) {
  return spendingCashFlowDataSchema.parse({
    categoryBreakdown: result.categoryBreakdown,
    from: result.from,
    granularity: result.granularity,
    includePending: result.includePending,
    merchantBreakdown: result.merchantBreakdown,
    timeSeries: result.timeSeries,
    to: result.to,
    totals: result.totals,
  });
}

export async function processAnalyticsRequest(
  request: AnalyticsRouteRequest,
  dependencies: AnalyticsRouteDependencies,
): Promise<AnalyticsRouteResult | null> {
  if (request.url.pathname !== '/v1/analytics/spending-summary') return null;
  const requestId = dependencies.requestId?.() ?? randomUUID();
  if (!canonicalUuidSchema.safeParse(requestId).success) {
    throw new TypeError('Analytics request IDs must be canonical UUIDs.');
  }
  const webAuthorized = requireWebOwnerCredential(
    request.authorizationHeader,
    dependencies.webToken,
  );
  const mcpAuthorized = requireMcpReadOnlyCredential(
    request.authorizationHeader,
    dependencies.mcpToken,
  );
  if (!webAuthorized && !mcpAuthorized) {
    return problem(401, 'Unauthorized', 'UNAUTHORIZED', requestId);
  }
  if (request.method !== 'GET') {
    const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
    return { ...result, headers: { ...result.headers, allow: 'GET' } };
  }
  if (request.hasBody) {
    return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
  }
  const input = parseQuery(request.url.searchParams);
  if (input === null) return problem(400, 'Invalid analytics query', 'INVALID_QUERY', requestId);

  try {
    const result = await dependencies.repository.summarize(dependencies.workspaceId, input);
    const generatedAt = (dependencies.now?.() ?? new Date()).toISOString();
    return {
      body: {
        data: dataJson(result),
        freshness: analyticsFreshnessSchema.parse({
          ...result.freshness,
          lastSuccessfulSyncAt: result.freshness.lastSuccessfulSyncAt?.toISOString() ?? null,
          oldestAccountSyncAt: result.freshness.oldestAccountSyncAt?.toISOString() ?? null,
        }),
        meta: {
          generatedAt,
          policyVersion: result.policyVersion,
          requestId,
          workspaceId: dependencies.workspaceId,
        },
        warnings: z.array(spendingCashFlowWarningSchema).max(6).parse(result.warnings),
      },
      headers: { 'x-request-id': requestId },
      status: 200,
    };
  } catch (error) {
    if (error instanceof AnalyticsWorkspaceNotFoundError) {
      return problem(404, 'Workspace not found', 'NOT_FOUND', requestId);
    }
    if (error instanceof TypeError || error instanceof z.ZodError) {
      return problem(400, 'Invalid analytics request', 'INVALID_REQUEST', requestId);
    }
    throw error;
  }
}
