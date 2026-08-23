import {
  parseBankDate,
  parseDecimalString,
  parseInstant,
  type CurrencyCode,
  type DecimalString,
} from '@cashcount/domain';
import {
  listTransactionsInputSchema,
  providerAccountSchema,
  providerBillSchema,
  providerConnectionSchema,
  providerTransactionSchema,
  type CursorPage,
  type FinancialDataProvider,
  type ListTransactionsInput,
  type ProviderAccountDto,
  type ProviderBillDto,
  type ProviderConnectionDto,
  type ProviderConnectionLocalStatus,
  type ProviderTransactionDto,
} from '@cashcount/provider-core';
import { isLosslessNumber, parse, type LosslessNumber } from 'lossless-json';
import { z } from 'zod';

import type { PluggyAuthenticatedHttpClient } from './authenticated-http-client.js';

const idSchema = z.string().uuid();
const textSchema = z.string().trim().min(1).max(1_000);
const nullableTextSchema = textSchema.nullish();
const rawNumberSchema = z.custom<LosslessNumber>(isLosslessNumber, 'Expected a JSON number.');

const rawConnectorSchema = z
  .object({
    id: rawNumberSchema,
    name: textSchema,
  })
  .passthrough();

const rawItemSchema = z
  .object({
    id: idSchema,
    connector: rawConnectorSchema,
    status: textSchema,
    executionStatus: textSchema,
    error: z.object({ code: textSchema }).passthrough().nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    lastUpdatedAt: z.string().nullish(),
    consentExpiresAt: z.string().nullish(),
  })
  .passthrough();

const rawItemListSchema = z.object({ results: z.array(rawItemSchema) }).passthrough();

const rawCreditDataSchema = z
  .object({
    balanceCloseDate: z.string().nullish(),
    balanceDueDate: z.string().nullish(),
    availableCreditLimit: rawNumberSchema.nullish(),
    creditLimit: rawNumberSchema.nullish(),
    status: z.enum(['ACTIVE', 'BLOCKED', 'CANCELLED']).nullish(),
  })
  .passthrough();

const rawAccountSchema = z
  .object({
    id: idSchema,
    itemId: idSchema,
    type: z.enum(['BANK', 'CREDIT']),
    subtype: z.enum(['CHECKING_ACCOUNT', 'SAVINGS_ACCOUNT', 'CREDIT_CARD']),
    number: z.string(),
    name: textSchema,
    balance: rawNumberSchema,
    currencyCode: z.string(),
    creditData: rawCreditDataSchema.nullish(),
    updatedAt: z.string(),
  })
  .passthrough();

const rawAccountListSchema = z.object({ results: z.array(rawAccountSchema) }).passthrough();

const rawMerchantSchema = z
  .object({
    name: textSchema.nullish(),
    businessName: nullableTextSchema,
  })
  .passthrough();

const rawCreditCardMetadataSchema = z
  .object({
    installmentNumber: rawNumberSchema.nullish(),
    totalInstallments: rawNumberSchema.nullish(),
    totalAmount: rawNumberSchema.nullish(),
    purchaseDate: z.string().nullish(),
    payeeMCC: rawNumberSchema.nullish(),
    cardNumber: z.string().nullish(),
    billId: z.string().nullish(),
    billForecastDate: z.string().nullish(),
    feeType: nullableTextSchema,
    feeTypeAdditionalInfo: nullableTextSchema,
    otherCreditsType: nullableTextSchema,
    otherCreditsAdditionalInfo: nullableTextSchema,
  })
  .passthrough();

const rawTransactionSchema = z
  .object({
    id: idSchema,
    accountId: idSchema,
    status: z.enum(['PENDING', 'POSTED']).nullish(),
    type: z.enum(['DEBIT', 'CREDIT']).nullish(),
    amount: rawNumberSchema,
    amountInAccountCurrency: rawNumberSchema.nullish(),
    currencyCode: z.string(),
    date: z.string(),
    description: textSchema,
    descriptionRaw: nullableTextSchema,
    providerCode: nullableTextSchema,
    providerId: nullableTextSchema,
    operationType: nullableTextSchema,
    operationTypeAdditionalInfo: nullableTextSchema,
    categoryId: nullableTextSchema,
    category: nullableTextSchema,
    merchant: rawMerchantSchema.nullish(),
    creditCardMetadata: rawCreditCardMetadataSchema.nullish(),
  })
  .passthrough();

const rawTransactionPageSchema = z
  .object({
    results: z.array(rawTransactionSchema),
    next: z.string().min(1).nullable(),
  })
  .passthrough();

const rawBillPaymentSchema = z
  .object({
    id: idSchema,
    valueType: textSchema,
    paymentDate: z.string(),
    paymentMode: nullableTextSchema,
    amount: rawNumberSchema,
    currencyCode: z.string(),
  })
  .passthrough();

const rawBillFinanceChargeSchema = z
  .object({
    id: idSchema,
    type: textSchema,
    amount: rawNumberSchema,
    currencyCode: z.string(),
    additionalInfo: nullableTextSchema,
  })
  .passthrough();

const rawBillSchema = z
  .object({
    id: idSchema,
    dueDate: z.string(),
    billClosingDate: z.string().nullish(),
    totalAmount: rawNumberSchema,
    totalAmountCurrencyCode: z.string(),
    minimumPaymentAmount: rawNumberSchema.nullish(),
    allowsInstallments: z.boolean().nullish(),
    payments: z.array(rawBillPaymentSchema),
    financeCharges: z.array(rawBillFinanceChargeSchema),
  })
  .passthrough();

const rawBillListSchema = z.object({ results: z.array(rawBillSchema) }).passthrough();

type RawAccount = z.output<typeof rawAccountSchema>;
type RawBill = z.output<typeof rawBillSchema>;
type RawItem = z.output<typeof rawItemSchema>;
type RawTransaction = z.output<typeof rawTransactionSchema>;

export class PluggyResponseValidationError extends Error {
  public constructor(public readonly pathname: string) {
    super(`Pluggy returned an invalid response for ${pathname}.`);
    this.name = 'PluggyResponseValidationError';
  }
}

function expandJsonNumber(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(value);
  if (match === null) {
    throw new TypeError('Invalid provider JSON number.');
  }

  const sign = match[1] ?? '';
  const integer = match[2] ?? '';
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? '0');
  if (!Number.isSafeInteger(exponent)) {
    throw new TypeError('Provider JSON number exponent is outside the supported range.');
  }

  const digits = integer + fraction;
  const decimalIndex = integer.length + exponent;
  if (decimalIndex <= 0) {
    return `${sign}0.${'0'.repeat(-decimalIndex)}${digits}`;
  }
  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function decimal(value: LosslessNumber): DecimalString {
  return parseDecimalString(expandJsonNumber(value.toString()));
}

function safeInteger(value: LosslessNumber): number {
  const text = value.toString();
  if (!/^-?\d+$/u.test(text)) {
    throw new TypeError('Expected an integer provider number.');
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError('Provider integer is outside the safe range.');
  }
  return parsed;
}

function bankDate(value: string): ReturnType<typeof parseBankDate> {
  return parseBankDate(value.slice(0, 10));
}

function instantOrNull(value: null | string | undefined): null | string {
  if (value === null || value === undefined) {
    return null;
  }
  parseInstant(value);
  return value;
}

function nullable<T>(value: null | T | undefined): null | T {
  return value ?? null;
}

function lastDigits(value: string, minimum: number): string | null {
  const digits = value.replace(/\D/gu, '');
  return digits.length < minimum ? null : digits.slice(-4);
}

function initialLifecycle(item: RawItem): ProviderConnectionLocalStatus {
  if (item.status === 'WAITING_USER_INPUT' || item.executionStatus === 'WAITING_USER_INPUT') {
    return 'USER_INPUT_REQUIRED';
  }
  if (
    item.executionStatus === 'WAITING_USER_ACTION' ||
    item.executionStatus === 'USER_AUTHORIZATION_PENDING'
  ) {
    return 'USER_ACTION_REQUIRED';
  }
  if (
    item.status === 'LOGIN_ERROR' ||
    item.executionStatus === 'INVALID_CREDENTIALS' ||
    item.executionStatus === 'ACCOUNT_CREDENTIALS_RESET' ||
    item.executionStatus === 'USER_AUTHORIZATION_REVOKED'
  ) {
    return 'REAUTH_REQUIRED';
  }
  if (
    item.status === 'UPDATING' ||
    item.executionStatus === 'CREATED' ||
    item.executionStatus.endsWith('_IN_PROGRESS')
  ) {
    return 'SYNCING';
  }
  if (
    item.status === 'UPDATED' &&
    (item.executionStatus === 'SUCCESS' || item.executionStatus === 'PARTIAL_SUCCESS')
  ) {
    return 'ACTIVE';
  }
  return 'PROVIDER_ERROR';
}

function mapConnection(item: RawItem): ProviderConnectionDto {
  return providerConnectionSchema.parse({
    externalConnectionId: item.id,
    externalConnectorId: String(safeInteger(item.connector.id)),
    displayName: item.connector.name,
    localStatus: initialLifecycle(item),
    itemStatus: item.status,
    executionStatus: item.executionStatus,
    errorCode: item.error?.code ?? null,
    actionRequiredAt: null,
    consentExpiresAt: instantOrNull(item.consentExpiresAt),
    providerUpdatedAt: instantOrNull(item.lastUpdatedAt ?? item.updatedAt),
    raw: item,
  });
}

function accountType(account: RawAccount): 'CHECKING' | 'CREDIT_CARD' | 'SAVINGS' {
  if (account.type === 'CREDIT' && account.subtype === 'CREDIT_CARD') {
    return 'CREDIT_CARD';
  }
  if (account.type === 'BANK' && account.subtype === 'SAVINGS_ACCOUNT') {
    return 'SAVINGS';
  }
  if (account.type === 'BANK' && account.subtype === 'CHECKING_ACCOUNT') {
    return 'CHECKING';
  }
  throw new TypeError('Pluggy returned an incompatible account type/subtype pair.');
}

function dateDay(value: null | string | undefined): null | number {
  return value === null || value === undefined ? null : Number(bankDate(value).slice(-2));
}

function mapAccount(account: RawAccount, institutionName: string): ProviderAccountDto {
  const type = accountType(account);
  const creditData = account.creditData;
  return providerAccountSchema.parse({
    externalAccountId: account.id,
    externalConnectionId: account.itemId,
    accountType: type,
    accountSubtype: account.subtype,
    name: account.name,
    institutionName,
    currency: account.currencyCode,
    maskedNumber: lastDigits(account.number, 1),
    currentBalance: decimal(account.balance),
    availableBalance: type === 'CHECKING' || type === 'SAVINGS' ? decimal(account.balance) : null,
    creditLimit:
      creditData?.creditLimit === null || creditData?.creditLimit === undefined
        ? null
        : decimal(creditData.creditLimit),
    availableCreditLimit:
      creditData?.availableCreditLimit === null || creditData?.availableCreditLimit === undefined
        ? null
        : decimal(creditData.availableCreditLimit),
    closingDay: dateDay(creditData?.balanceCloseDate),
    dueDay: dateDay(creditData?.balanceDueDate),
    isActive: creditData?.status !== 'CANCELLED',
    providerUpdatedAt: instantOrNull(account.updatedAt),
    raw: account,
  });
}

function mapTransaction(
  transaction: RawTransaction,
  accountCurrency: CurrencyCode,
): ProviderTransactionDto {
  const card = transaction.creditCardMetadata;
  const merchant = transaction.merchant;
  const mappedCard =
    card === null || card === undefined
      ? null
      : {
          installmentNumber:
            card.installmentNumber === null || card.installmentNumber === undefined
              ? null
              : safeInteger(card.installmentNumber),
          totalInstallments:
            card.totalInstallments === null || card.totalInstallments === undefined
              ? null
              : safeInteger(card.totalInstallments),
          totalAmount:
            card.totalAmount === null || card.totalAmount === undefined
              ? null
              : decimal(card.totalAmount),
          mcc:
            card.payeeMCC === null || card.payeeMCC === undefined
              ? null
              : String(safeInteger(card.payeeMCC)),
          cardLastFour:
            card.cardNumber === null || card.cardNumber === undefined
              ? null
              : lastDigits(card.cardNumber, 4),
          billId: nullable(card.billId),
          billForecastMonth: nullable(card.billForecastDate),
          feeType: nullable(card.feeType),
          feeTypeAdditionalInfo: nullable(card.feeTypeAdditionalInfo),
          otherCreditType: nullable(card.otherCreditsType),
          otherCreditAdditionalInfo: nullable(card.otherCreditsAdditionalInfo),
        };

  return providerTransactionSchema.parse({
    externalTransactionId: transaction.id,
    providerId: nullable(transaction.providerId),
    providerCode: nullable(transaction.providerCode),
    externalAccountId: transaction.accountId,
    status: transaction.status ?? 'UNKNOWN',
    providerType: nullable(transaction.type),
    amountSigned: decimal(transaction.amount),
    currency: transaction.currencyCode,
    amountInAccountCurrencySigned:
      transaction.amountInAccountCurrency === null ||
      transaction.amountInAccountCurrency === undefined
        ? null
        : decimal(transaction.amountInAccountCurrency),
    accountCurrency,
    transactionAt: transaction.date,
    purchaseAt: instantOrNull(card?.purchaseDate),
    description: transaction.description,
    descriptionRaw: nullable(transaction.descriptionRaw),
    operationType: nullable(transaction.operationType),
    operationTypeAdditionalInfo: nullable(transaction.operationTypeAdditionalInfo),
    categoryId: nullable(transaction.categoryId),
    categoryName: nullable(transaction.category),
    merchant:
      merchant?.name === null || merchant?.name === undefined
        ? null
        : { name: merchant.name, businessName: nullable(merchant.businessName) },
    creditCardMetadata: mappedCard,
    raw: transaction,
  });
}

function mapBill(bill: RawBill, externalAccountId: string): ProviderBillDto {
  return providerBillSchema.parse({
    externalBillId: bill.id,
    externalAccountId,
    status: 'UNKNOWN',
    providerStatus: null,
    dueDate: bankDate(bill.dueDate),
    closeDate:
      bill.billClosingDate === null || bill.billClosingDate === undefined
        ? null
        : bankDate(bill.billClosingDate),
    totalAmount: decimal(bill.totalAmount),
    minimumPayment:
      bill.minimumPaymentAmount === null || bill.minimumPaymentAmount === undefined
        ? null
        : decimal(bill.minimumPaymentAmount),
    currency: bill.totalAmountCurrencyCode,
    allowsInstallments: nullable(bill.allowsInstallments),
    payments: bill.payments.map((payment) => ({
      externalPaymentId: payment.id,
      valueType: payment.valueType,
      paymentDate: bankDate(payment.paymentDate),
      paymentMode: nullable(payment.paymentMode),
      amount: decimal(payment.amount),
      currency: payment.currencyCode,
      raw: payment,
    })),
    financeCharges: bill.financeCharges.map((charge) => ({
      externalChargeId: charge.id,
      chargeType: charge.type,
      amount: decimal(charge.amount),
      currency: charge.currencyCode,
      additionalInfo: nullable(charge.additionalInfo),
      raw: charge,
    })),
    providerUpdatedAt: null,
    raw: bill,
  });
}

async function parseResponse<T extends z.ZodType>(
  response: Response,
  pathname: string,
  schema: T,
): Promise<z.output<T>> {
  try {
    const value = parse(await response.text());
    return schema.parse(value);
  } catch {
    throw new PluggyResponseValidationError(pathname);
  }
}

function transactionPath(input: ListTransactionsInput): string {
  if (input.cursor === null) {
    const query = new URLSearchParams({ accountId: input.externalAccountId });
    return `/v2/transactions?${query.toString()}`;
  }

  if (!input.cursor.startsWith('?')) {
    throw new TypeError('Pluggy transaction cursors must be ready-to-use query strings.');
  }
  const url = new URL(`/v2/transactions${input.cursor}`, 'https://provider.invalid');
  const accountIds = url.searchParams.getAll('accountId');
  if (accountIds.length !== 1 || accountIds[0] !== input.externalAccountId) {
    throw new TypeError('Pluggy transaction cursor account does not match the request.');
  }
  const allowed = new Set(['accountId', 'after', 'createdAtFrom', 'dateFrom', 'dateTo', 'ids']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new TypeError('Pluggy transaction cursor contains an unsupported filter.');
    }
  }
  return `${url.pathname}${url.search}`;
}

export interface PluggyDataClientOptions {
  httpClient: PluggyAuthenticatedHttpClient;
}

export class PluggyDataClient implements FinancialDataProvider {
  readonly #accountCurrency = new Map<string, CurrencyCode>();
  readonly #http: PluggyAuthenticatedHttpClient;

  public constructor(options: PluggyDataClientOptions) {
    this.#http = options.httpClient;
  }

  public async listConnections(): Promise<ProviderConnectionDto[]> {
    const response = await this.#http.request('/items');
    const page = await parseResponse(response, '/items', rawItemListSchema);
    return page.results.map(mapConnection);
  }

  public async getConnection(externalConnectionId: string): Promise<ProviderConnectionDto> {
    const id = idSchema.parse(externalConnectionId);
    return mapConnection(await this.#getItem(id));
  }

  public async requestConnectionRefresh(externalConnectionId: string): Promise<void> {
    const id = idSchema.parse(externalConnectionId);
    const pathname = `/items/${encodeURIComponent(id)}`;
    const response = await this.#http.request(pathname, {
      body: '{}',
      headers: { 'content-type': 'application/json' },
      method: 'PATCH',
    });
    await parseResponse(response, pathname, rawItemSchema);
  }

  public async listAccounts(externalConnectionId: string): Promise<ProviderAccountDto[]> {
    const id = idSchema.parse(externalConnectionId);
    const query = new URLSearchParams({ itemId: id });
    const [item, response] = await Promise.all([
      this.#getItem(id),
      this.#http.request(`/accounts?${query.toString()}`),
    ]);
    const page = await parseResponse(response, '/accounts', rawAccountListSchema);
    return page.results.map((account) => {
      const mapped = mapAccount(account, item.connector.name);
      this.#accountCurrency.set(mapped.externalAccountId, mapped.currency);
      return mapped;
    });
  }

  public async listTransactions(
    input: ListTransactionsInput,
  ): Promise<CursorPage<ProviderTransactionDto>> {
    const parsedInput = listTransactionsInputSchema.parse(input);
    let currency = this.#accountCurrency.get(parsedInput.externalAccountId);
    if (currency === undefined) {
      const account = await this.#getAccount(parsedInput.externalAccountId);
      const mapped = mapAccount(account, 'Provider account');
      currency = mapped.currency;
      this.#accountCurrency.set(parsedInput.externalAccountId, currency);
    }

    const path = transactionPath(parsedInput);
    const response = await this.#http.request(path);
    const page = await parseResponse(response, '/v2/transactions', rawTransactionPageSchema);
    if (page.next !== null) {
      transactionPath({ externalAccountId: parsedInput.externalAccountId, cursor: page.next });
    }
    return {
      items: page.results.map((transaction) => mapTransaction(transaction, currency)),
      nextCursor: page.next,
    };
  }

  public async listCreditCardBills(externalAccountId: string): Promise<ProviderBillDto[]> {
    const id = idSchema.parse(externalAccountId);
    const query = new URLSearchParams({ accountId: id });
    const response = await this.#http.request(`/bills?${query.toString()}`);
    const page = await parseResponse(response, '/bills', rawBillListSchema);
    return page.results.map((bill) => mapBill(bill, id));
  }

  async #getAccount(id: string): Promise<RawAccount> {
    const parsedId = idSchema.parse(id);
    const pathname = `/accounts/${encodeURIComponent(parsedId)}`;
    const response = await this.#http.request(pathname);
    return parseResponse(response, pathname, rawAccountSchema);
  }

  async #getItem(id: string): Promise<RawItem> {
    const pathname = `/items/${encodeURIComponent(id)}`;
    const response = await this.#http.request(pathname);
    return parseResponse(response, pathname, rawItemSchema);
  }
}

const createdWebhookHintSchema = z
  .object({
    accountId: idSchema,
    transactionsCreatedAtFrom: z.string().refine((value) => {
      try {
        parseInstant(value);
        return true;
      } catch {
        return false;
      }
    }),
    createdTransactionsLink: z.string().url().optional(),
    createdTransactionsLinkV2: z.string().url().optional(),
  })
  .refine(
    (value) =>
      value.createdTransactionsLink !== undefined || value.createdTransactionsLinkV2 !== undefined,
    'A Pluggy created-transactions link is required.',
  );

export type PluggyCreatedTransactionsHint = z.input<typeof createdWebhookHintSchema>;

export function normalizePluggyCreatedTransactionsHint(
  input: PluggyCreatedTransactionsHint,
  baseUrl = 'https://api.pluggy.ai',
): ListTransactionsInput {
  const hint = createdWebhookHintSchema.parse(input);
  const providerOrigin = new URL(baseUrl).origin;
  const source = new URL(hint.createdTransactionsLinkV2 ?? hint.createdTransactionsLink ?? '');
  const expectedPath =
    hint.createdTransactionsLinkV2 === undefined ? '/transactions' : '/v2/transactions';
  if (source.origin !== providerOrigin || source.pathname !== expectedPath) {
    throw new TypeError('Pluggy webhook transaction link has an unexpected origin or path.');
  }
  if (
    source.searchParams.get('accountId') !== hint.accountId ||
    source.searchParams.get('createdAtFrom') !== hint.transactionsCreatedAtFrom
  ) {
    throw new TypeError(
      'Pluggy webhook transaction link does not match its account/timestamp evidence.',
    );
  }

  const query = new URLSearchParams({
    accountId: hint.accountId,
    createdAtFrom: hint.transactionsCreatedAtFrom,
  });
  const after = source.searchParams.get('after');
  if (expectedPath === '/v2/transactions' && after !== null && !after.includes('{')) {
    query.set('after', after);
  }
  return listTransactionsInputSchema.parse({
    externalAccountId: hint.accountId,
    cursor: `?${query.toString()}`,
  });
}
