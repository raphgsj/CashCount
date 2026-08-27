import { randomUUID } from 'node:crypto';

import {
  AnalyticsWorkspaceNotFoundError,
  type PeriodComparisonInput,
  type PeriodComparisonResult,
  type SpendingCashFlowInput,
  type SpendingCashFlowResult,
} from '@cashcount/analytics';
import {
  analyticsFreshnessSchema,
  periodComparisonDataSchema,
  spendingCashFlowDataSchema,
  spendingCashFlowWarningSchema,
} from '@cashcount/contracts';
import { z } from 'zod';

import { requireMcpReadOnlyCredential } from './mcp-readonly-auth.js';
import { requireWebOwnerCredential } from './web-owner-auth.js';

const canonicalUuidSchema = z.uuid();
const dateSchema = z.iso.date();
const summaryQueryKeys = new Set([
  'accountId',
  'categoryId',
  'from',
  'granularity',
  'includePending',
  'merchantId',
  'to',
]);
const comparisonQueryKeys = new Set([
  'accountId',
  'categoryId',
  'comparisonFrom',
  'comparisonTo',
  'currentFrom',
  'currentTo',
  'includePending',
  'merchantId',
  'mode',
  'sameElapsedDays',
]);

export interface AnalyticsRouteRepository {
  comparePeriods(
    workspaceId: string,
    input: PeriodComparisonInput,
  ): Promise<PeriodComparisonResult>;
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
  if ([...searchParams.keys()].some((key) => !summaryQueryKeys.has(key))) return null;
  if ([...summaryQueryKeys].some((key) => searchParams.getAll(key).length > 1)) return null;
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

function parseBoolean(value: string | null): boolean | undefined | null {
  if (value === null) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

function parseComparisonQuery(searchParams: URLSearchParams): PeriodComparisonInput | null {
  if ([...searchParams.keys()].some((key) => !comparisonQueryKeys.has(key))) return null;
  if ([...comparisonQueryKeys].some((key) => searchParams.getAll(key).length > 1)) return null;
  const currentFrom = searchParams.get('currentFrom');
  const currentTo = searchParams.get('currentTo');
  const mode = searchParams.get('mode');
  if (
    currentFrom === null ||
    currentTo === null ||
    !dateSchema.safeParse(currentFrom).success ||
    !dateSchema.safeParse(currentTo).success ||
    (mode !== 'PREVIOUS_PERIOD' &&
      mode !== 'PREVIOUS_MONTH' &&
      mode !== 'PREVIOUS_YEAR' &&
      mode !== 'CUSTOM')
  ) {
    return null;
  }
  const comparisonFrom = searchParams.get('comparisonFrom');
  const comparisonTo = searchParams.get('comparisonTo');
  if (
    (comparisonFrom !== null && !dateSchema.safeParse(comparisonFrom).success) ||
    (comparisonTo !== null && !dateSchema.safeParse(comparisonTo).success) ||
    (mode === 'CUSTOM' && (comparisonFrom === null || comparisonTo === null)) ||
    (mode !== 'CUSTOM' && (comparisonFrom !== null || comparisonTo !== null))
  ) {
    return null;
  }
  const accountId = searchParams.get('accountId');
  const categoryId = searchParams.get('categoryId');
  const merchantId = searchParams.get('merchantId');
  for (const id of [accountId, categoryId, merchantId]) {
    if (id !== null && !canonicalUuidSchema.safeParse(id).success) return null;
  }
  const includePending = parseBoolean(searchParams.get('includePending'));
  const sameElapsedDays = parseBoolean(searchParams.get('sameElapsedDays'));
  if (includePending === null || sameElapsedDays === null) return null;
  return {
    ...(accountId === null ? {} : { accountId }),
    ...(categoryId === null ? {} : { categoryId }),
    ...(comparisonFrom === null ? {} : { comparisonFrom }),
    ...(comparisonTo === null ? {} : { comparisonTo }),
    currentFrom,
    currentTo,
    ...(includePending === undefined ? {} : { includePending }),
    ...(merchantId === null ? {} : { merchantId }),
    mode,
    ...(sameElapsedDays === undefined ? {} : { sameElapsedDays }),
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

function comparisonDataJson(result: PeriodComparisonResult) {
  return periodComparisonDataSchema.parse({
    categoryChanges: result.categoryChanges,
    comparisonFrom: result.comparisonFrom,
    comparisonTo: result.comparisonTo,
    currentFrom: result.currentFrom,
    currentTo: result.currentTo,
    includePending: result.includePending,
    mode: result.mode,
    sameElapsedDays: result.sameElapsedDays,
    totals: result.totals,
  });
}

export async function processAnalyticsRequest(
  request: AnalyticsRouteRequest,
  dependencies: AnalyticsRouteDependencies,
): Promise<AnalyticsRouteResult | null> {
  const isSummary = request.url.pathname === '/v1/analytics/spending-summary';
  const isComparison = request.url.pathname === '/v1/analytics/compare-periods';
  if (!isSummary && !isComparison) return null;
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
  const input = isSummary
    ? parseQuery(request.url.searchParams)
    : parseComparisonQuery(request.url.searchParams);
  if (input === null) return problem(400, 'Invalid analytics query', 'INVALID_QUERY', requestId);

  try {
    const result = isSummary
      ? await dependencies.repository.summarize(
          dependencies.workspaceId,
          input as SpendingCashFlowInput,
        )
      : await dependencies.repository.comparePeriods(
          dependencies.workspaceId,
          input as PeriodComparisonInput,
        );
    const generatedAt = (dependencies.now?.() ?? new Date()).toISOString();
    return {
      body: {
        data: isSummary
          ? dataJson(result as SpendingCashFlowResult)
          : comparisonDataJson(result as PeriodComparisonResult),
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
