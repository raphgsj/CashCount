import { randomUUID } from 'node:crypto';

import type {
  InstallmentCommitmentsInput,
  InstallmentCommitmentsResult,
} from '@cashcount/analytics';
import { z } from 'zod';

import { requireMcpReadOnlyCredential } from './mcp-readonly-auth.js';
import { requireWebOwnerCredential } from './web-owner-auth.js';

const uuidSchema = z.uuid();
const decimalSchema = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
const moneySchema = z.object({ currency: z.string().regex(/^[A-Z]{3}$/u), value: decimalSchema });
const seriesSchema = z
  .object({
    estimatedInstallmentAmount: moneySchema.nullable(),
    estimatedNextMonth: z.iso.date().nullable(),
    estimatedRemainingCommitment: moneySchema.nullable(),
    highestConfirmedInstallment: z.number().int().nonnegative(),
    merchantLabel: z.string().trim().min(1).max(500).nullable(),
    originalTotalAmount: moneySchema.nullable(),
    purchaseDate: z.iso.date().nullable(),
    remainingInstallments: z.number().int().nonnegative(),
    status: z.enum(['CANDIDATE', 'CONFIRMED', 'NEEDS_REVIEW', 'COMPLETED']),
    totalInstallments: z.number().int().positive(),
  })
  .strict();
const dataSchema = z
  .object({
    includeReviewStates: z.boolean(),
    monthly: z
      .array(
        z
          .object({
            estimatedAmount: moneySchema,
            estimatedInstallmentCount: z.number().int().positive(),
            month: z.iso.date(),
          })
          .strict(),
      )
      .max(1200),
    series: z.array(seriesSchema).max(100),
  })
  .strict();

export interface InstallmentRouteRepository {
  list(
    workspaceId: string,
    input: InstallmentCommitmentsInput,
  ): Promise<InstallmentCommitmentsResult>;
}

export interface InstallmentRouteDependencies {
  mcpToken: string;
  now?: () => Date;
  repository: InstallmentRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface InstallmentRouteRequest {
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

function dataJson(result: InstallmentCommitmentsResult) {
  const money = (currency: string, value: string | null) =>
    value === null ? null : { currency, value };
  return dataSchema.parse({
    includeReviewStates: result.includeReviewStates,
    monthly: result.monthly.map((item) => ({
      estimatedAmount: money(item.currency, item.estimatedAmount),
      estimatedInstallmentCount: item.estimatedInstallmentCount,
      month: item.month,
    })),
    series: result.series.map((item) => ({
      estimatedInstallmentAmount: money(item.currency, item.estimatedInstallmentAmount),
      estimatedNextMonth: item.estimatedNextMonth,
      estimatedRemainingCommitment: money(item.currency, item.estimatedRemainingCommitment),
      highestConfirmedInstallment: item.highestConfirmedInstallment,
      merchantLabel: item.merchantLabel,
      originalTotalAmount: money(item.currency, item.originalTotalAmount),
      purchaseDate: item.purchaseDate,
      remainingInstallments: item.remainingInstallments,
      status: item.status,
      totalInstallments: item.totalInstallments,
    })),
  });
}

export async function processInstallmentRequest(
  request: InstallmentRouteRequest,
  dependencies: InstallmentRouteDependencies,
) {
  const cardMatch = /^\/v1\/cards\/([^/]+)\/installments$/u.exec(request.url.pathname);
  const isAnalytics = request.url.pathname === '/v1/analytics/installment-commitments';
  if (cardMatch === null && !isAnalytics) return null;
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
  if (!webAuthorized && (!isAnalytics || !mcpAuthorized)) {
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
  const cardId = cardMatch?.[1];
  if (cardId !== undefined && !uuidSchema.safeParse(cardId).success) {
    return problem(400, 'Invalid card ID', 'INVALID_ID', requestId);
  }
  try {
    const result = await dependencies.repository.list(dependencies.workspaceId, {
      ...(cardId === undefined ? {} : { cardId }),
      includeReviewStates: !isAnalytics,
    });
    const generatedAt = (dependencies.now?.() ?? new Date()).toISOString();
    return {
      body: {
        data: dataJson(result),
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
  } catch (error) {
    if (error instanceof TypeError || error instanceof z.ZodError) {
      return problem(400, 'Invalid installment request', 'INVALID_REQUEST', requestId);
    }
    throw error;
  }
}
