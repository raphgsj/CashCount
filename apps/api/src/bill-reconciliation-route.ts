import { randomUUID } from 'node:crypto';

import {
  BillReconciliationConflictError,
  BillReconciliationNotFoundError,
  type BillPaymentReconciliationCandidate,
  type CardBillReconciliationSummary,
} from '@cashcount/db/finance';
import { z } from 'zod';

import { requireMcpReadOnlyCredential } from './mcp-readonly-auth.js';
import { maskSensitiveDigitSequences } from './public-text.js';
import { requireWebOwnerCredential } from './web-owner-auth.js';

const canonicalUuidSchema = z.uuid();
const commandSchema = z
  .object({ candidateId: canonicalUuidSchema, actorId: z.string().trim().min(1).max(200) })
  .strict();
const decimalStringSchema = z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u);
const moneySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  value: decimalStringSchema,
});
const candidateSchema = z
  .object({
    amount: moneySchema,
    confidence: decimalStringSchema.nullable(),
    description: z.string().max(1_000),
    id: canonicalUuidSchema,
    matchStatus: z.enum(['UNMATCHED', 'CANDIDATE', 'AUTO_MATCHED', 'USER_CONFIRMED', 'REJECTED']),
    transactionDate: z.iso.date(),
    transactionId: canonicalUuidSchema,
  })
  .strict();
const summarySchema = z
  .object({
    billId: canonicalUuidSchema,
    billStatus: z.string().trim().min(1).max(100),
    cardId: canonicalUuidSchema,
    closeDate: z.iso.date().nullable(),
    confirmedBankPaymentCount: z.number().int().nonnegative(),
    confirmedBankPaymentTotal: moneySchema,
    differenceAmount: moneySchema.nullable(),
    dueDate: z.iso.date().nullable(),
    financeChargeTotal: moneySchema,
    linkedTransactionTotal: moneySchema,
    normalizedPaymentTotal: moneySchema,
    pendingPurchaseTotal: moneySchema,
    postedNetSpendingTotal: moneySchema,
    providerBillTotal: moneySchema.nullable(),
    reconciliationStatus: z.enum(['UNKNOWN', 'TOLERANCE_REQUIRED', 'NEEDS_REVIEW', 'RECONCILED']),
    toleranceAmount: moneySchema.nullable(),
    unresolvedItemCount: z.number().int().nonnegative(),
    unconvertedTransactionCount: z.number().int().nonnegative(),
  })
  .strict();

export interface BillReconciliationRouteRepository {
  confirmCandidate(
    workspaceId: string,
    paymentId: string,
    candidateId: string,
    actorId: string,
  ): Promise<BillPaymentReconciliationCandidate>;
  generateCandidates(
    workspaceId: string,
    paymentId: string,
  ): Promise<BillPaymentReconciliationCandidate[]>;
  getSummary(workspaceId: string, billId: string): Promise<CardBillReconciliationSummary | null>;
  rejectCandidate(
    workspaceId: string,
    paymentId: string,
    candidateId: string,
    actorId: string,
  ): Promise<BillPaymentReconciliationCandidate>;
}

export interface BillReconciliationRouteDependencies {
  mcpToken: string;
  now?: () => Date;
  repository: BillReconciliationRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface BillReconciliationRouteRequest {
  authorizationHeader: string | null;
  body: unknown;
  method: string;
  url: URL;
}

export interface BillReconciliationRouteResult {
  body: unknown;
  headers: Readonly<Record<string, string>>;
  status: number;
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
  } satisfies BillReconciliationRouteResult;
}

function candidateJson(record: BillPaymentReconciliationCandidate) {
  return candidateSchema.parse({
    amount: { currency: record.currency, value: record.amount },
    confidence: record.confidence,
    description: maskSensitiveDigitSequences(record.description),
    id: record.id,
    matchStatus: record.matchStatus,
    transactionDate: record.transactionDate,
    transactionId: record.transactionId,
  });
}

function summaryJson(record: CardBillReconciliationSummary) {
  const money = (value: string) => ({ currency: record.currency, value });
  return summarySchema.parse({
    billId: record.billId,
    billStatus: record.billStatus,
    cardId: record.cardId,
    closeDate: record.closeDate,
    confirmedBankPaymentCount: record.confirmedBankPaymentCount,
    confirmedBankPaymentTotal: money(record.confirmedBankPaymentTotal),
    differenceAmount: record.differenceAmount === null ? null : money(record.differenceAmount),
    dueDate: record.dueDate,
    financeChargeTotal: money(record.financeChargeTotal),
    linkedTransactionTotal: money(record.linkedTransactionTotal),
    normalizedPaymentTotal: money(record.normalizedPaymentTotal),
    pendingPurchaseTotal: money(record.pendingPurchaseTotal),
    postedNetSpendingTotal: money(record.postedNetSpendingTotal),
    providerBillTotal: record.providerBillTotal === null ? null : money(record.providerBillTotal),
    reconciliationStatus: record.reconciliationStatus,
    toleranceAmount: record.toleranceAmount === null ? null : money(record.toleranceAmount),
    unresolvedItemCount: record.unresolvedItemCount,
    unconvertedTransactionCount: record.unconvertedTransactionCount,
  });
}

export async function processBillReconciliationRequest(
  request: BillReconciliationRouteRequest,
  dependencies: BillReconciliationRouteDependencies,
): Promise<BillReconciliationRouteResult | null> {
  const summaryMatch = /^\/v1\/card-bills\/([^/]+)\/reconciliation$/u.exec(request.url.pathname);
  const candidateMatch = /^\/v1\/bill-payments\/([^/]+)\/reconciliation-candidates$/u.exec(
    request.url.pathname,
  );
  const confirmMatch = /^\/v1\/bill-payments\/([^/]+)\/confirm-reconciliation$/u.exec(
    request.url.pathname,
  );
  const rejectMatch = /^\/v1\/bill-payments\/([^/]+)\/reject-reconciliation$/u.exec(
    request.url.pathname,
  );
  if (
    summaryMatch === null &&
    candidateMatch === null &&
    confirmMatch === null &&
    rejectMatch === null
  ) {
    return null;
  }
  const requestId = dependencies.requestId?.() ?? randomUUID();
  if (!canonicalUuidSchema.safeParse(requestId).success) {
    throw new TypeError('Bill reconciliation request IDs must be canonical UUIDs.');
  }
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
  const isSummary = summaryMatch !== null;
  if ((!isSummary && !webAuthorized) || (isSummary && !webAuthorized && !mcpAuthorized)) {
    return problem(401, 'Unauthorized', 'UNAUTHORIZED', requestId);
  }
  if ((isSummary && request.method !== 'GET') || (!isSummary && request.method !== 'POST')) {
    const allowed = isSummary ? 'GET' : 'POST';
    const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
    return { ...result, headers: { ...result.headers, allow: allowed } };
  }
  const idMatch = summaryMatch ?? candidateMatch ?? confirmMatch ?? rejectMatch;
  const id = idMatch?.[1];
  if (id === undefined || !canonicalUuidSchema.safeParse(id).success) {
    return problem(400, 'Invalid ID', 'INVALID_ID', requestId);
  }
  try {
    if (summaryMatch !== null) {
      if (request.body !== undefined) {
        return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
      }
      const record = await dependencies.repository.getSummary(dependencies.workspaceId, id);
      if (record === null) return problem(404, 'Card bill not found', 'NOT_FOUND', requestId);
      const now = dependencies.now?.() ?? new Date();
      const isStale =
        record.lastSuccessfulSyncAt === null ||
        now.getTime() - record.lastSuccessfulSyncAt.getTime() > 86_400_000;
      return {
        body: {
          data: summaryJson(record),
          freshness: {
            isStale,
            lastSuccessfulSyncAt: record.lastSuccessfulSyncAt?.toISOString() ?? null,
            staleAfterMinutes: 1440,
          },
          meta: {
            generatedAt: now.toISOString(),
            policyVersion: record.policyVersion,
            requestId,
            workspaceId: dependencies.workspaceId,
          },
          warnings:
            record.reconciliationStatus === 'RECONCILED'
              ? []
              : [{ affectedBillCount: 1, code: 'UNRECONCILED_BILL' }],
        },
        headers: { 'x-request-id': requestId },
        status: 200,
      };
    }
    if (candidateMatch !== null) {
      if (request.body !== undefined && !z.object({}).strict().safeParse(request.body).success) {
        return problem(400, 'Invalid command', 'INVALID_COMMAND', requestId);
      }
      const items = await dependencies.repository.generateCandidates(dependencies.workspaceId, id);
      return {
        body: { data: { items: items.map(candidateJson), limit: 20 } },
        headers: { 'x-request-id': requestId },
        status: 200,
      };
    }
    const parsed = commandSchema.safeParse(request.body);
    if (!parsed.success) return problem(400, 'Invalid command', 'INVALID_COMMAND', requestId);
    const record =
      confirmMatch === null
        ? await dependencies.repository.rejectCandidate(
            dependencies.workspaceId,
            id,
            parsed.data.candidateId,
            parsed.data.actorId,
          )
        : await dependencies.repository.confirmCandidate(
            dependencies.workspaceId,
            id,
            parsed.data.candidateId,
            parsed.data.actorId,
          );
    return {
      body: { data: candidateJson(record) },
      headers: { 'x-request-id': requestId },
      status: 200,
    };
  } catch (error) {
    if (error instanceof BillReconciliationNotFoundError) {
      return problem(404, 'Reconciliation evidence not found', 'NOT_FOUND', requestId);
    }
    if (error instanceof BillReconciliationConflictError) {
      return problem(409, 'Reconciliation conflict', 'CONFLICT', requestId);
    }
    if (error instanceof TypeError || error instanceof z.ZodError) {
      return problem(400, 'Invalid reconciliation request', 'INVALID_REQUEST', requestId);
    }
    throw error;
  }
}
