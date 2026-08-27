import { randomUUID } from 'node:crypto';

import type { AnomalyCandidatesResult, MonthForecastResult } from '@cashcount/analytics';
import { z } from 'zod';

import { requireMcpReadOnlyCredential } from './mcp-readonly-auth.js';
import { requireWebOwnerCredential } from './web-owner-auth.js';

const uuidSchema = z.uuid();
const decimalSchema = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
const moneySchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/u), value: decimalSchema });
const candidateSchema = z
  .object({
    baselineAmount: moneySchema.nullable(),
    categoryLabel: z.string().trim().min(1).max(500).nullable(),
    deviationPercent: decimalSchema.nullable(),
    merchantLabel: z.string().trim().min(1).max(500).nullable(),
    observedAmount: moneySchema,
    observedOn: z.iso.date(),
    rule: z.enum([
      'CATEGORY_SPEND_SPIKE',
      'DUPLICATE_LIKE_CHARGE',
      'MERCHANT_AMOUNT_SPIKE',
      'NEW_RECURRING_MERCHANT',
      'RECURRING_AMOUNT_INCREASE',
    ]),
    status: z.literal('CANDIDATE'),
    thresholdAmount: moneySchema.nullable(),
  })
  .strict();
const anomalyDataSchema = z
  .object({ asOf: z.iso.date(), candidates: z.array(candidateSchema).max(100) })
  .strict();
const forecastCurrencySchema = z
  .object({
    actualMonthToDate: moneySchema,
    commitmentFloorForecast: moneySchema,
    confirmedInstallmentsRemaining: moneySchema,
    confirmedRecurringRemaining: moneySchema,
    elapsedDays: z.number().int().min(1).max(31),
    forecastTotal: moneySchema,
    knownCommitmentsRemaining: moneySchema,
    remainingDays: z.number().int().min(0).max(30),
    runRateForecast: moneySchema,
    runRateRemaining: moneySchema,
    trailingThreeMonthAverage: moneySchema,
  })
  .strict();
const forecastDataSchema = z
  .object({
    asOf: z.iso.date(),
    currencies: z.array(forecastCurrencySchema).max(100),
    monthEnd: z.iso.date(),
    monthStart: z.iso.date(),
  })
  .strict();

export interface AnomalyForecastRouteRepository {
  anomalies(workspaceId: string, generatedAt: Date): Promise<AnomalyCandidatesResult>;
  forecast(workspaceId: string, generatedAt: Date): Promise<MonthForecastResult>;
}

export interface AnomalyForecastRouteDependencies {
  mcpToken: string;
  now?: () => Date;
  repository: AnomalyForecastRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface AnomalyForecastRouteRequest {
  authorizationHeader: string | null;
  hasBody: boolean;
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

function money(currency: string, value: string | null) {
  return value === null ? null : { currency, value };
}

function anomalyData(result: AnomalyCandidatesResult) {
  return anomalyDataSchema.parse({
    asOf: result.asOf,
    candidates: result.candidates.map((candidate) => ({
      baselineAmount: money(candidate.currency, candidate.baselineValue),
      categoryLabel: candidate.categoryLabel,
      deviationPercent: candidate.deviationPercent,
      merchantLabel: candidate.merchantLabel,
      observedAmount: money(candidate.currency, candidate.observedValue),
      observedOn: candidate.observedOn,
      rule: candidate.rule,
      status: candidate.status,
      thresholdAmount: money(candidate.currency, candidate.thresholdValue),
    })),
  });
}

function forecastData(result: MonthForecastResult) {
  return forecastDataSchema.parse({
    asOf: result.asOf,
    currencies: result.currencies.map((item) => ({
      actualMonthToDate: money(item.currency, item.actualMonthToDate),
      commitmentFloorForecast: money(item.currency, item.commitmentFloorForecast),
      confirmedInstallmentsRemaining: money(item.currency, item.confirmedInstallmentsRemaining),
      confirmedRecurringRemaining: money(item.currency, item.confirmedRecurringRemaining),
      elapsedDays: item.elapsedDays,
      forecastTotal: money(item.currency, item.forecastTotal),
      knownCommitmentsRemaining: money(item.currency, item.knownCommitmentsRemaining),
      remainingDays: item.remainingDays,
      runRateForecast: money(item.currency, item.runRateForecast),
      runRateRemaining: money(item.currency, item.runRateRemaining),
      trailingThreeMonthAverage: money(item.currency, item.trailingThreeMonthAverage),
    })),
    monthEnd: result.monthEnd,
    monthStart: result.monthStart,
  });
}

export async function processAnomalyForecastRequest(
  request: AnomalyForecastRouteRequest,
  dependencies: AnomalyForecastRouteDependencies,
) {
  const isAnomalies = request.url.pathname === '/v1/analytics/anomaly-candidates';
  const isForecast = request.url.pathname === '/v1/analytics/month-forecast';
  if (!isAnomalies && !isForecast) return null;
  const requestId = dependencies.requestId?.() ?? randomUUID();
  if (!uuidSchema.safeParse(requestId).success) throw new TypeError('Invalid request ID.');
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
  if (request.hasBody)
    return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
  if ([...request.url.searchParams].length > 0) {
    return problem(400, 'Query parameters are not allowed', 'INVALID_QUERY', requestId);
  }
  const generatedAt = dependencies.now?.() ?? new Date();
  try {
    const result = isAnomalies
      ? await dependencies.repository.anomalies(dependencies.workspaceId, generatedAt)
      : await dependencies.repository.forecast(dependencies.workspaceId, generatedAt);
    const data = 'candidates' in result ? anomalyData(result) : forecastData(result);
    return {
      body: {
        data,
        freshness: {
          isStale: result.freshness.isStale,
          lastSuccessfulSyncAt: result.freshness.lastSuccessfulSyncAt?.toISOString() ?? null,
          oldestAccountSyncAt: result.freshness.oldestAccountSyncAt?.toISOString() ?? null,
          staleAfterMinutes: 1440,
        },
        meta: {
          generatedAt: generatedAt.toISOString(),
          policyVersion: result.policyVersion,
          requestId,
          workspaceId: dependencies.workspaceId,
        },
        warnings: result.warnings,
      },
      headers: { 'x-request-id': requestId },
      status: 200,
    };
  } catch (error) {
    if (error instanceof TypeError || error instanceof z.ZodError) {
      return problem(400, 'Invalid anomaly or forecast request', 'INVALID_REQUEST', requestId);
    }
    throw error;
  }
}
