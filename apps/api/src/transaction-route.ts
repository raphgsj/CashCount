import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import {
  transactionPatchSchema,
  transactionSchema,
  transactionStatuses,
  type Transaction,
  type TransactionPatch,
} from '@cashcount/contracts';
import {
  TransactionNotFoundError,
  TransactionUserStateConflictError,
  TransactionUserStateReferenceError,
  type TransactionApiListInput,
  type TransactionApiPage,
  type TransactionApiRecord,
  type TransactionApiUpdateInput,
} from '@cashcount/db/finance';
import { z } from 'zod';

import { requireWebOwnerCredential } from './web-owner-auth.js';

const canonicalUuidSchema = z.uuid();
const dateSchema = z.iso.date();
const listQuerySchema = z
  .object({
    accountId: canonicalUuidSchema.optional(),
    categoryId: canonicalUuidSchema.optional(),
    cursor: z.string().min(1).max(512).optional(),
    from: dateSchema,
    limit: z
      .string()
      .regex(/^[1-9]\d*$/u)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(50),
    status: z.enum(transactionStatuses).optional(),
    to: dateSchema,
  })
  .strict();
const cursorSchema = z
  .object({
    accountId: canonicalUuidSchema.nullable(),
    categoryId: canonicalUuidSchema.nullable(),
    from: dateSchema,
    id: canonicalUuidSchema,
    localDate: dateSchema,
    status: z.enum(transactionStatuses).nullable(),
    to: dateSchema,
    version: z.literal(1),
  })
  .strict();

type TransactionListQuery = z.infer<typeof listQuerySchema>;

export interface TransactionRouteRepository {
  get(workspaceId: string, transactionId: string): Promise<TransactionApiRecord | null>;
  list(input: TransactionApiListInput): Promise<TransactionApiPage>;
  update(input: TransactionApiUpdateInput): Promise<TransactionApiRecord>;
}

export interface TransactionRouteDependencies {
  actorId: string;
  now?: () => Date;
  repository: TransactionRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface TransactionRouteRequest {
  authorizationHeader: null | string;
  body: unknown;
  hasBody: boolean;
  method: string;
  url: URL;
}

export interface TransactionRouteResult {
  body: unknown;
  headers: Readonly<Record<string, string>>;
  status: number;
}

function problem(
  status: number,
  title: string,
  code: string,
  requestId: string,
  details?: Record<string, unknown>,
): TransactionRouteResult {
  return {
    body: {
      code,
      ...details,
      requestId,
      status,
      title,
      type: `https://cashcount.invalid/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    },
    headers: { 'x-request-id': requestId },
    status,
  };
}

function money(currency: string, value: null | string) {
  return value === null ? null : { currency, value };
}

function publicDescription(value: string): string {
  return value.replace(/(?<!\d)\d(?:[\s.-]?\d){4,18}(?!\d)/gu, (candidate) => {
    if (/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return candidate;
    const digits = candidate.replaceAll(/\D/gu, '');
    return `••••${digits.slice(-4)}`;
  });
}

function nullableOverride(enabled: boolean, id: null | string) {
  if (!enabled) return { mode: 'INHERIT' as const };
  return id === null ? { mode: 'CLEAR' as const } : { id, mode: 'SET' as const };
}

function transactionJson(record: TransactionApiRecord): Transaction {
  const cardContext =
    record.accountType === 'CREDIT_CARD' ||
    record.installmentNumber !== null ||
    record.installmentTotal !== null ||
    record.installmentTotalAmount !== null ||
    record.cardLastFour !== null ||
    record.payeeMcc !== null ||
    record.billForecastMonth !== null;
  return transactionSchema.parse({
    account: {
      accountType: record.accountType,
      id: record.accountId,
      maskedNumber: record.accountMaskedNumber,
      name: record.accountName,
    },
    accountCurrencyAmount: money(record.accountCurrency, record.accountCurrencyAmountSigned),
    analyticsAmount: money(record.analyticsCurrency, record.analyticsAmountSigned),
    bill:
      record.billId === null || record.billStatus === null
        ? null
        : {
            closeDate: record.billCloseDate,
            dueDate: record.billDueDate,
            id: record.billId,
            status: record.billStatus,
          },
    card: cardContext
      ? {
          billForecastMonth: record.billForecastMonth,
          installmentNumber: record.installmentNumber,
          installmentTotal: record.installmentTotal,
          installmentTotalAmount: money(record.providerCurrency, record.installmentTotalAmount),
          lastFour: record.cardLastFour,
          mcc: record.payeeMcc,
        }
      : null,
    description: publicDescription(record.description),
    duplicateReviewStatus: record.duplicateReviewStatus,
    effective: {
      category: {
        override: nullableOverride(record.categoryOverrideEnabled, record.effectiveCategoryId),
        source: record.effectiveCategorySource,
        value:
          record.effectiveCategoryId === null || record.effectiveCategoryName === null
            ? null
            : { id: record.effectiveCategoryId, name: record.effectiveCategoryName },
      },
      excludedFromSpend: {
        override:
          record.effectiveExclusionSource === 'USER'
            ? { mode: 'SET', value: record.effectiveIsExcludedFromSpend }
            : { mode: 'INHERIT' },
        source: record.effectiveExclusionSource,
        value: record.effectiveIsExcludedFromSpend,
      },
      financialRole: {
        override:
          record.financialRoleOverrideEnabled && record.effectiveFinancialRole !== null
            ? { mode: 'SET', value: record.effectiveFinancialRole }
            : { mode: 'INHERIT' },
        source: record.effectiveFinancialRoleSource,
        value: record.effectiveFinancialRole,
      },
      merchant: {
        override: nullableOverride(record.merchantOverrideEnabled, record.effectiveMerchantId),
        source: record.effectiveMerchantSource,
        value:
          record.effectiveMerchantId === null || record.effectiveMerchantName === null
            ? null
            : { id: record.effectiveMerchantId, name: record.effectiveMerchantName },
      },
    },
    freshness: {
      isStale: record.isStale,
      lastSuccessfulSyncAt: record.effectiveLastSuccessfulSyncAt?.toISOString() ?? null,
      requiresConnectionAttention: record.requiresConnectionAttention,
    },
    id: record.id,
    localDate: record.localDate,
    notes: record.notes,
    originalAmount: money(record.providerCurrency, record.providerAmountSigned),
    purchaseAt: record.providerPurchaseAt?.toISOString() ?? null,
    purchaseLocalDate: record.purchaseLocalDate,
    replacementContext: record.replacementContext,
    reviewStatus: record.reviewStatus,
    status: record.status,
    tags: record.tags,
    transactionAt: record.providerTransactionAt.toISOString(),
    userStateVersion: record.userStateVersion,
    warnings: record.warnings.map(warningJson),
  });
}

function warningJson(warning: TransactionApiRecord['warnings'][number]) {
  return warning.code === 'STALE_DATA'
    ? {
        ...warning,
        lastSuccessfulSyncAt: warning.lastSuccessfulSyncAt?.toISOString() ?? null,
      }
    : warning;
}

function parseListQuery(searchParams: URLSearchParams): TransactionListQuery | null {
  const values: Record<string, string> = {};
  for (const key of searchParams.keys()) {
    if (searchParams.getAll(key).length !== 1) return null;
    const value = searchParams.get(key);
    if (value === null) return null;
    values[key] = value;
  }
  const parsed = listQuerySchema.safeParse(values);
  if (!parsed.success) return null;
  const from = Date.parse(`${parsed.data.from}T00:00:00Z`);
  const to = Date.parse(`${parsed.data.to}T00:00:00Z`);
  if (from > to || (to - from) / 86_400_000 > 366) return null;
  return parsed.data;
}

function decodeCursor(encoded: string, query: TransactionListQuery) {
  try {
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown,
    );
    if (
      parsed.from !== query.from ||
      parsed.to !== query.to ||
      parsed.accountId !== (query.accountId ?? null) ||
      parsed.categoryId !== (query.categoryId ?? null) ||
      parsed.status !== (query.status ?? null)
    ) {
      return null;
    }
    return { id: parsed.id, localDate: parsed.localDate };
  } catch {
    return null;
  }
}

function encodeCursor(
  cursor: NonNullable<TransactionApiPage['nextCursor']>,
  query: TransactionListQuery,
): string {
  return Buffer.from(
    JSON.stringify({
      accountId: query.accountId ?? null,
      categoryId: query.categoryId ?? null,
      from: query.from,
      ...cursor,
      status: query.status ?? null,
      to: query.to,
      version: 1,
    }),
  ).toString('base64url');
}

function categoryPatch(patch: NonNullable<TransactionPatch['categoryOverride']>) {
  return patch.mode === 'SET' ? { mode: 'SET' as const, value: patch.categoryId } : patch;
}

function merchantPatch(patch: NonNullable<TransactionPatch['merchantOverride']>) {
  return patch.mode === 'SET' ? { mode: 'SET' as const, value: patch.merchantId } : patch;
}

function updateInput(
  patch: TransactionPatch,
  dependencies: TransactionRouteDependencies,
  transactionId: string,
): TransactionApiUpdateInput {
  return {
    actorId: dependencies.actorId,
    ...(patch.categoryOverride === undefined
      ? {}
      : { categoryOverride: categoryPatch(patch.categoryOverride) }),
    ...(patch.excludedFromSpendOverride === undefined
      ? {}
      : { excludedFromSpendOverride: patch.excludedFromSpendOverride }),
    expectedVersion: patch.expectedVersion,
    ...(patch.financialRoleOverride === undefined
      ? {}
      : { financialRoleOverride: patch.financialRoleOverride }),
    ...(patch.merchantOverride === undefined
      ? {}
      : { merchantOverride: merchantPatch(patch.merchantOverride) }),
    ...(patch.notes === undefined ? {} : { notes: patch.notes }),
    ...(patch.reviewStatus === undefined ? {} : { reviewStatus: patch.reviewStatus }),
    ...(patch.tagIds === undefined ? {} : { tagIds: patch.tagIds }),
    transactionId,
    workspaceId: dependencies.workspaceId,
  };
}

export async function processTransactionRequest(
  request: TransactionRouteRequest,
  dependencies: TransactionRouteDependencies,
): Promise<TransactionRouteResult | null> {
  const path = request.url.pathname;
  const detail = /^\/v1\/transactions\/([^/]+)$/u.exec(path);
  if (path !== '/v1/transactions' && detail === null) return null;
  const requestId = dependencies.requestId?.() ?? randomUUID();
  if (!canonicalUuidSchema.safeParse(requestId).success) {
    throw new TypeError('Transaction request IDs must be canonical UUIDs.');
  }
  if (!requireWebOwnerCredential(request.authorizationHeader, dependencies.webToken)) {
    return problem(401, 'Unauthorized', 'UNAUTHORIZED', requestId);
  }
  const meta = (warnings: Transaction['warnings']) => ({
    generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    requestId,
    warnings,
    workspaceId: dependencies.workspaceId,
  });
  const success = (data: unknown, warnings: Transaction['warnings']): TransactionRouteResult => ({
    body: { data, meta: meta(warnings) },
    headers: { 'x-request-id': requestId },
    status: 200,
  });

  if (path === '/v1/transactions') {
    if (request.hasBody) {
      return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
    }
    if (request.method !== 'GET') {
      const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
      return { ...result, headers: { ...result.headers, allow: 'GET' } };
    }
    const query = parseListQuery(request.url.searchParams);
    if (query === null) return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor, query);
    if (query.cursor !== undefined && cursor === null) {
      return problem(400, 'Invalid cursor', 'INVALID_CURSOR', requestId);
    }
    const page = await dependencies.repository.list({
      ...(query.accountId === undefined ? {} : { accountId: query.accountId }),
      ...(query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
      ...(cursor === undefined || cursor === null ? {} : { cursor }),
      from: query.from,
      limit: query.limit,
      ...(query.status === undefined ? {} : { status: query.status }),
      to: query.to,
      workspaceId: dependencies.workspaceId,
    });
    const items = page.items.map(transactionJson);
    const warnings = transactionSchema.shape.warnings.parse(
      [...page.warnings.map(warningJson), ...items.flatMap((item) => item.warnings)].filter(
        (warning, index, all) =>
          all.findIndex((candidate) => JSON.stringify(candidate) === JSON.stringify(warning)) ===
          index,
      ),
    );
    return success(
      {
        items,
        page: {
          limit: query.limit,
          nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor, query),
        },
      },
      warnings,
    );
  }

  if (request.url.search.length > 0) {
    return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
  }
  const id = canonicalUuidSchema.safeParse(detail?.[1]);
  if (!id.success) return problem(400, 'Invalid ID', 'INVALID_ID', requestId);
  if (request.method === 'GET') {
    if (request.hasBody) {
      return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
    }
    const transaction = await dependencies.repository.get(dependencies.workspaceId, id.data);
    if (transaction === null) return problem(404, 'Transaction not found', 'NOT_FOUND', requestId);
    const json = transactionJson(transaction);
    return success(json, json.warnings);
  }
  if (request.method !== 'PATCH') {
    const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
    return { ...result, headers: { ...result.headers, allow: 'GET, PATCH' } };
  }
  if (!request.hasBody) return problem(400, 'Request body is required', 'BODY_REQUIRED', requestId);
  const patch = transactionPatchSchema.safeParse(request.body);
  if (!patch.success) return problem(400, 'Invalid transaction patch', 'INVALID_BODY', requestId);
  try {
    const updated = transactionJson(
      await dependencies.repository.update(updateInput(patch.data, dependencies, id.data)),
    );
    return success(updated, updated.warnings);
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      return problem(404, 'Transaction not found', 'NOT_FOUND', requestId);
    }
    if (error instanceof TransactionUserStateConflictError) {
      return problem(409, 'Transaction version conflict', 'VERSION_CONFLICT', requestId, {
        actualVersion: error.actualVersion,
      });
    }
    if (error instanceof TransactionUserStateReferenceError) {
      return problem(400, 'Invalid transaction reference', 'INVALID_REFERENCE', requestId, {
        field: error.field,
      });
    }
    if (error instanceof TypeError) {
      return problem(400, 'Invalid transaction patch', 'INVALID_BODY', requestId);
    }
    throw error;
  }
}
