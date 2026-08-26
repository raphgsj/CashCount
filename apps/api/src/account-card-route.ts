import { randomUUID } from 'node:crypto';

import type {
  AccountCardRecord,
  CardBillFinanceChargeRecord,
  CardBillPaymentRecord,
  CardBillRecord,
} from '@cashcount/db/finance';
import { z } from 'zod';

import { requireWebOwnerCredential } from './web-owner-auth.js';

const canonicalUuidSchema = z.uuid();
const boundedTextSchema = z.string().trim().min(1).max(1_000);
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u, 'Expected an exact decimal string.');
const moneySchema = z
  .object({ currency: currencySchema, value: decimalStringSchema })
  .strict()
  .nullable();
const accountSummarySchema = z
  .object({
    accountSubtype: boundedTextSchema.nullable(),
    accountType: z.enum(['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'INVESTMENT', 'OTHER']),
    availableBalance: moneySchema,
    currentBalance: moneySchema,
    historyCoverage: z
      .object({
        earliestDate: z.iso.date().nullable(),
        latestDate: z.iso.date().nullable(),
        status: z.enum([
          'UNKNOWN',
          'PARTIAL',
          'PROVIDER_MAXIMUM_RETRIEVED',
          'USER_EXTENDED_HISTORY',
        ]),
      })
      .strict(),
    id: z.uuid(),
    institutionName: boundedTextSchema,
    isActive: z.boolean(),
    lastSuccessfulSyncAt: z.iso.datetime({ offset: true }).nullable(),
    maskedNumber: z
      .string()
      .regex(/^[0-9]{1,4}$/u)
      .nullable(),
    name: boundedTextSchema,
  })
  .strict();
const cardSummarySchema = accountSummarySchema
  .extend({
    accountType: z.literal('CREDIT_CARD'),
    availableCreditLimit: moneySchema,
    closingDay: z.number().int().min(1).max(31).nullable(),
    creditLimit: moneySchema,
    dueDay: z.number().int().min(1).max(31).nullable(),
  })
  .strict();
const cardBillSummarySchema = z
  .object({
    allowsInstallments: z.boolean().nullable(),
    cardId: z.uuid(),
    closeDate: z.iso.date().nullable(),
    dueDate: z.iso.date().nullable(),
    id: z.uuid(),
    minimumPayment: moneySchema,
    status: boundedTextSchema,
    totalAmount: moneySchema,
  })
  .strict();
const cardBillPaymentSchema = z
  .object({
    amount: z.object({ currency: currencySchema, value: decimalStringSchema }).strict(),
    id: z.uuid(),
    isMatchedToCardTransaction: z.boolean(),
    paymentDate: z.iso.date(),
    paymentMode: boundedTextSchema.nullable(),
    valueType: boundedTextSchema,
  })
  .strict();
const cardBillFinanceChargeSchema = z
  .object({
    additionalInfo: boundedTextSchema.nullable(),
    amount: z.object({ currency: currencySchema, value: decimalStringSchema }).strict(),
    chargeType: boundedTextSchema,
    id: z.uuid(),
    isMatchedToTransaction: z.boolean(),
  })
  .strict();

export interface AccountCardRouteRepository {
  getAccount(workspaceId: string, accountId: string): Promise<AccountCardRecord | null>;
  getCard(workspaceId: string, cardId: string): Promise<AccountCardRecord | null>;
  getCardBill(workspaceId: string, billId: string): Promise<CardBillRecord | null>;
  listAccounts(workspaceId: string, limit?: number): Promise<AccountCardRecord[]>;
  listBillFinanceCharges(
    workspaceId: string,
    billId: string,
    limit?: number,
  ): Promise<CardBillFinanceChargeRecord[] | null>;
  listBillPayments(
    workspaceId: string,
    billId: string,
    limit?: number,
  ): Promise<CardBillPaymentRecord[] | null>;
  listCardBills(
    workspaceId: string,
    cardId: string,
    limit?: number,
  ): Promise<CardBillRecord[] | null>;
  listCards(workspaceId: string, limit?: number): Promise<AccountCardRecord[]>;
}

export interface AccountCardRouteDependencies {
  now?: () => Date;
  repository: AccountCardRouteRepository;
  requestId?: () => string;
  webToken: string;
  workspaceId: string;
}

export interface AccountCardRouteRequest {
  authorizationHeader: null | string;
  hasBody: boolean;
  method: string;
  url: URL;
}

export interface AccountCardRouteResult {
  body: unknown;
  headers: Readonly<Record<string, string>>;
  status: number;
}

function problem(
  status: number,
  title: string,
  code: string,
  requestId: string,
): AccountCardRouteResult {
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

function money(currency: string, value: null | string) {
  return value === null ? null : { currency, value };
}

function accountJson(record: AccountCardRecord) {
  return accountSummarySchema.parse({
    accountSubtype: record.accountSubtype,
    accountType: record.accountType,
    availableBalance: money(record.currency, record.availableBalance),
    currentBalance: money(record.currency, record.currentBalance),
    historyCoverage: {
      earliestDate: record.providerHistoryEarliestDate,
      latestDate: record.providerHistoryLatestDate,
      status: record.historyCoverageStatus,
    },
    id: record.id,
    institutionName: record.institutionName,
    isActive: record.isActive,
    lastSuccessfulSyncAt: record.lastSuccessfulSyncAt?.toISOString() ?? null,
    maskedNumber: record.maskedNumber,
    name: record.name,
  });
}

function cardJson(record: AccountCardRecord) {
  return cardSummarySchema.parse({
    ...accountJson(record),
    accountType: record.accountType,
    availableCreditLimit: money(record.currency, record.availableCreditLimit),
    closingDay: record.closingDay,
    creditLimit: money(record.currency, record.creditLimit),
    dueDay: record.dueDay,
  });
}

function billJson(record: CardBillRecord) {
  return cardBillSummarySchema.parse({
    allowsInstallments: record.allowsInstallments,
    cardId: record.cardId,
    closeDate: record.closeDate,
    dueDate: record.dueDate,
    id: record.id,
    minimumPayment: money(record.currency, record.minimumPayment),
    status: record.status,
    totalAmount: money(record.currency, record.totalAmount),
  });
}

function paymentJson(record: CardBillPaymentRecord) {
  return cardBillPaymentSchema.parse({
    amount: { currency: record.currency, value: record.amount },
    id: record.id,
    isMatchedToCardTransaction: record.isMatchedToCardTransaction,
    paymentDate: record.paymentDate,
    paymentMode: record.paymentMode,
    valueType: record.valueType,
  });
}

function financeChargeJson(record: CardBillFinanceChargeRecord) {
  return cardBillFinanceChargeSchema.parse({
    additionalInfo: record.additionalInfo,
    amount: { currency: record.currency, value: record.amount },
    chargeType: record.chargeType,
    id: record.id,
    isMatchedToTransaction: record.isMatchedToTransaction,
  });
}

function parseLimit(searchParams: URLSearchParams): number | null {
  if ([...searchParams.keys()].some((key) => key !== 'limit')) return null;
  if (searchParams.getAll('limit').length > 1) return null;
  const raw = searchParams.get('limit');
  if (raw === null) return 100;
  if (!/^[1-9]\d*$/u.test(raw)) return null;
  const limit = Number(raw);
  return Number.isSafeInteger(limit) && limit <= 100 ? limit : null;
}

export async function processAccountCardRequest(
  request: AccountCardRouteRequest,
  dependencies: AccountCardRouteDependencies,
): Promise<AccountCardRouteResult | null> {
  const path = request.url.pathname;
  const accountDetail = /^\/v1\/accounts\/([^/]+)$/u.exec(path);
  const cardDetail = /^\/v1\/cards\/([^/]+)$/u.exec(path);
  const cardBills = /^\/v1\/cards\/([^/]+)\/bills$/u.exec(path);
  const billDetail = /^\/v1\/card-bills\/([^/]+)$/u.exec(path);
  const billPayments = /^\/v1\/card-bills\/([^/]+)\/payments$/u.exec(path);
  const billCharges = /^\/v1\/card-bills\/([^/]+)\/finance-charges$/u.exec(path);
  const recognized =
    path === '/v1/accounts' ||
    path === '/v1/cards' ||
    accountDetail !== null ||
    cardDetail !== null ||
    cardBills !== null ||
    billDetail !== null ||
    billPayments !== null ||
    billCharges !== null;
  if (!recognized) return null;

  const requestId = dependencies.requestId?.() ?? randomUUID();
  if (!canonicalUuidSchema.safeParse(requestId).success) {
    throw new TypeError('Account/card request IDs must be canonical UUIDs.');
  }
  if (!requireWebOwnerCredential(request.authorizationHeader, dependencies.webToken)) {
    return problem(401, 'Unauthorized', 'UNAUTHORIZED', requestId);
  }
  if (request.hasBody)
    return problem(400, 'Request body is not allowed', 'BODY_NOT_ALLOWED', requestId);
  if (request.method !== 'GET') {
    const result = problem(405, 'Method not allowed', 'METHOD_NOT_ALLOWED', requestId);
    return { ...result, headers: { ...result.headers, allow: 'GET' } };
  }
  const limit = parseLimit(request.url.searchParams);
  if (limit === null) return problem(400, 'Invalid query', 'INVALID_QUERY', requestId);
  const meta = {
    generatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
    requestId,
    workspaceId: dependencies.workspaceId,
  };
  const success = (data: unknown): AccountCardRouteResult => ({
    body: { data, meta },
    headers: { 'x-request-id': requestId },
    status: 200,
  });
  const parseId = (match: RegExpExecArray): null | string => {
    const parsed = canonicalUuidSchema.safeParse(match[1]);
    return parsed.success ? parsed.data : null;
  };

  if (path === '/v1/accounts') {
    return success({
      items: z
        .array(accountSummarySchema)
        .parse(
          (await dependencies.repository.listAccounts(dependencies.workspaceId, limit)).map(
            accountJson,
          ),
        ),
      limit,
    });
  }
  if (path === '/v1/cards') {
    return success({
      items: z
        .array(cardSummarySchema)
        .parse(
          (await dependencies.repository.listCards(dependencies.workspaceId, limit)).map(cardJson),
        ),
      limit,
    });
  }

  const match =
    accountDetail ?? cardBills ?? cardDetail ?? billPayments ?? billCharges ?? billDetail;
  if (match === null) return null;
  const id = parseId(match);
  if (id === null) return problem(400, 'Invalid ID', 'INVALID_ID', requestId);

  if (accountDetail !== null) {
    const record = await dependencies.repository.getAccount(dependencies.workspaceId, id);
    return record === null
      ? problem(404, 'Account not found', 'NOT_FOUND', requestId)
      : success(accountJson(record));
  }
  if (cardDetail !== null) {
    const record = await dependencies.repository.getCard(dependencies.workspaceId, id);
    return record === null
      ? problem(404, 'Card not found', 'NOT_FOUND', requestId)
      : success(cardJson(record));
  }
  if (cardBills !== null) {
    const records = await dependencies.repository.listCardBills(
      dependencies.workspaceId,
      id,
      limit,
    );
    return records === null
      ? problem(404, 'Card not found', 'NOT_FOUND', requestId)
      : success({ items: records.map(billJson), limit });
  }
  if (billPayments !== null) {
    const records = await dependencies.repository.listBillPayments(
      dependencies.workspaceId,
      id,
      limit,
    );
    return records === null
      ? problem(404, 'Card bill not found', 'NOT_FOUND', requestId)
      : success({ items: records.map(paymentJson), limit });
  }
  if (billCharges !== null) {
    const records = await dependencies.repository.listBillFinanceCharges(
      dependencies.workspaceId,
      id,
      limit,
    );
    return records === null
      ? problem(404, 'Card bill not found', 'NOT_FOUND', requestId)
      : success({ items: records.map(financeChargeJson), limit });
  }
  const bill = await dependencies.repository.getCardBill(dependencies.workspaceId, id);
  return bill === null
    ? problem(404, 'Card bill not found', 'NOT_FOUND', requestId)
    : success(billJson(bill));
}
