import { describe, expect, it, vi } from 'vitest';

import {
  normalizePluggyCreatedTransactionsHint,
  PluggyApiKeyProvider,
  PluggyAuthenticatedHttpClient,
  PluggyDataClient,
  PluggyResponseValidationError,
  PluggyTransportError,
} from './index.js';

const itemId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const transactionId = '33333333-3333-4333-8333-333333333333';
const billId = '44444444-4444-4444-8444-444444444444';
const paymentId = '55555555-5555-4555-8555-555555555555';
const chargeId = '66666666-6666-4666-8666-666666666666';

function textResponse(text: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(text, {
    headers: { 'content-type': 'application/json', ...headers },
    status,
  });
}

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return textResponse(JSON.stringify(value), status, headers);
}

function makeHttpClient(
  fetchImpl: typeof fetch,
  options: Partial<{
    maxRetries: number;
    random: () => number;
    sleep: (delayMs: number) => Promise<void>;
    timeoutMs: number;
  }> = {},
): PluggyAuthenticatedHttpClient {
  const provider = new PluggyApiKeyProvider({
    baseUrl: 'https://api.pluggy.ai',
    clientId: 'synthetic-client-id',
    clientSecret: 'synthetic-client-secret',
    fetchImpl,
    requestId: () => 'auth-request',
  });
  return new PluggyAuthenticatedHttpClient({
    apiKeyProvider: provider,
    baseUrl: 'https://api.pluggy.ai',
    fetchImpl,
    requestId: () => 'data-request',
    ...options,
  });
}

function itemJson(status = 'UPDATED', executionStatus = 'SUCCESS'): string {
  return `{
    "id":"${itemId}",
    "connector":{"id":601,"name":"Synthetic Bank","futureField":true},
    "status":"${status}",
    "executionStatus":"${executionStatus}",
    "lastUpdatedAt":"2026-08-23T12:00:00.000Z",
    "updatedAt":"2026-08-23T12:00:00.000Z",
    "consentExpiresAt":null,
    "error":null,
    "futureTopLevelField":"ignored"
  }`;
}

function accountJson(): string {
  return `{
    "id":"${accountId}",
    "itemId":"${itemId}",
    "type":"CREDIT",
    "subtype":"CREDIT_CARD",
    "number":"4111-1111-1111-0042",
    "name":"Synthetic card",
    "balance":1234.560000,
    "currencyCode":"BRL",
    "creditData":{
      "balanceCloseDate":"2026-08-10",
      "balanceDueDate":"2026-08-17",
      "availableCreditLimit":3765.440000,
      "creditLimit":5000.000000,
      "status":"ACTIVE"
    },
    "updatedAt":"2026-08-23T12:00:00.000Z"
  }`;
}

describe('PluggyDataClient', () => {
  it('lists and retrieves lifecycle-aware connections while accepting additive fields', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth') return json({ accessToken: 'synthetic-api-key' });
      if (url.pathname === '/items') return textResponse(`{"results":[${itemJson()}]}`);
      if (url.pathname === `/items/${itemId}`)
        return textResponse(itemJson('UPDATING', 'ACCOUNTS_IN_PROGRESS'));
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    const client = new PluggyDataClient({ httpClient: makeHttpClient(fetchImpl) });

    await expect(client.listConnections()).resolves.toMatchObject([
      {
        externalConnectionId: itemId,
        externalConnectorId: '601',
        displayName: 'Synthetic Bank',
        localStatus: 'ACTIVE',
      },
    ]);
    await expect(client.getConnection(itemId)).resolves.toMatchObject({
      localStatus: 'SYNCING',
      executionStatus: 'ACCOUNTS_IN_PROGRESS',
    });
  });

  it('maps accounts without exposing full account or card numbers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth') return json({ accessToken: 'synthetic-api-key' });
      if (url.pathname === `/items/${itemId}`) return textResponse(itemJson());
      if (url.pathname === '/accounts') {
        expect(url.searchParams.get('itemId')).toBe(itemId);
        return textResponse(`{"results":[${accountJson()}]}`);
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    const client = new PluggyDataClient({ httpClient: makeHttpClient(fetchImpl) });

    const accounts = await client.listAccounts(itemId);
    expect(accounts[0]).toMatchObject({
      accountType: 'CREDIT_CARD',
      maskedNumber: '0042',
      currentBalance: '1234.56',
      creditLimit: '5000',
      availableCreditLimit: '3765.44',
      closingDay: 10,
      dueDay: 17,
    });
    expect(JSON.stringify({ ...accounts[0], raw: undefined })).not.toContain('4111111111110042');
  });

  it('uses only V2 cursor transactions and preserves exact signed and card evidence', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/auth') return json({ accessToken: 'synthetic-api-key' });
      if (url.pathname === `/accounts/${accountId}`) return textResponse(accountJson());
      if (url.pathname === '/v2/transactions') {
        return textResponse(`{
          "results":[{
            "id":"${transactionId}",
            "accountId":"${accountId}",
            "status":"POSTED",
            "type":"CREDIT",
            "amount":-99999999999999.123456,
            "amountInAccountCurrency":-113.450000,
            "currencyCode":"USD",
            "date":"2026-08-23T09:30:00-03:00",
            "description":"Synthetic refund",
            "descriptionRaw":null,
            "providerCode":null,
            "providerId":null,
            "operationType":null,
            "operationTypeAdditionalInfo":null,
            "categoryId":null,
            "category":null,
            "merchant":null,
            "creditCardMetadata":{
              "installmentNumber":2,
              "totalInstallments":10,
              "totalAmount":1000.000000,
              "purchaseDate":"2026-08-20T12:00:00Z",
              "payeeMCC":5812,
              "cardNumber":"5555 5555 5555 0099",
              "billId":"${billId}",
              "billForecastDate":"2026-09",
              "feeType":null,
              "feeTypeAdditionalInfo":null,
              "otherCreditsType":null,
              "otherCreditsAdditionalInfo":null
            }
          }],
          "next":"?accountId=${accountId}&after=opaque-cursor"
        }`);
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    const client = new PluggyDataClient({ httpClient: makeHttpClient(fetchImpl) });

    const page = await client.listTransactions({ externalAccountId: accountId, cursor: null });
    expect(page.items[0]).toMatchObject({
      amountSigned: '-99999999999999.123456',
      amountInAccountCurrencySigned: '-113.45',
      currency: 'USD',
      accountCurrency: 'BRL',
      creditCardMetadata: {
        cardLastFour: '0099',
        installmentNumber: 2,
        totalInstallments: 10,
        totalAmount: '1000',
        billForecastMonth: '2026-09',
      },
    });
    expect(page.nextCursor).toBe(`?accountId=${accountId}&after=opaque-cursor`);
    expect(paths.some((path) => path.startsWith('/v2/transactions?'))).toBe(true);
    expect(paths.some((path) => path.startsWith('/transactions?'))).toBe(false);
  });

  it('maps bills, payment children, and finance-charge children without floating point', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth') return json({ accessToken: 'synthetic-api-key' });
      if (url.pathname === '/bills') {
        return textResponse(`{"results":[{
          "id":"${billId}",
          "dueDate":"2026-09-17T00:00:00.000Z",
          "billClosingDate":"2026-09-10T00:00:00.000Z",
          "totalAmount":1250.400000,
          "totalAmountCurrencyCode":"BRL",
          "minimumPaymentAmount":null,
          "allowsInstallments":true,
          "payments":[{
            "id":"${paymentId}","valueType":"FULL_PAYMENT",
            "paymentDate":"2026-08-17T00:00:00.000Z","paymentMode":"PIX",
            "amount":1200.000000,"currencyCode":"BRL"
          }],
          "financeCharges":[{
            "id":"${chargeId}","type":"IOF","amount":50.400000,
            "currencyCode":"BRL","additionalInfo":null
          }]
        }]}`);
      }
      throw new Error(`Unexpected path ${url.pathname}`);
    });
    const client = new PluggyDataClient({ httpClient: makeHttpClient(fetchImpl) });

    const bills = await client.listCreditCardBills(accountId);
    expect(bills[0]).toMatchObject({
      status: 'UNKNOWN',
      dueDate: '2026-09-17',
      closeDate: '2026-09-10',
      totalAmount: '1250.4',
      payments: [{ amount: '1200', paymentDate: '2026-08-17' }],
      financeCharges: [{ amount: '50.4', chargeType: 'IOF' }],
    });
  });

  it('validates response bodies before mapping', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      return url.pathname === '/auth'
        ? json({ accessToken: 'synthetic-api-key' })
        : textResponse('{"results":[{"id":"not-a-valid-item"}]}');
    });
    const client = new PluggyDataClient({ httpClient: makeHttpClient(fetchImpl) });

    await expect(client.listConnections()).rejects.toBeInstanceOf(PluggyResponseValidationError);
  });
});

describe('Pluggy HTTP reliability', () => {
  it('respects Retry-After for 429 and retries safe requests', async () => {
    const delays: number[] = [];
    let dataCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth') return json({ accessToken: 'synthetic-api-key' });
      dataCalls += 1;
      return dataCalls === 1
        ? json({ code: 429 }, 429, { 'retry-after': '2' })
        : json({ ok: true });
    });
    const http = makeHttpClient(fetchImpl, {
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await expect(http.request('/items')).resolves.toBeInstanceOf(Response);
    expect(delays).toEqual([2_000]);
    expect(dataCalls).toBe(2);
  });

  it('uses bounded exponential jitter for retryable 5xx responses', async () => {
    const delays: number[] = [];
    let dataCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth') return json({ accessToken: 'synthetic-api-key' });
      dataCalls += 1;
      return dataCalls < 3 ? json({ code: 503 }, 503) : json({ ok: true });
    });
    const http = makeHttpClient(fetchImpl, {
      random: () => 0,
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await http.request('/accounts');
    expect(delays).toEqual([125, 250]);
  });

  it('times out bounded requests and does not retry unsafe PATCH requests', async () => {
    let dataCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/auth') return json({ accessToken: 'synthetic-api-key' });
      dataCalls += 1;
      if (url.pathname === '/slow') {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        });
      }
      return json({ code: 503 }, 503);
    });
    const http = makeHttpClient(fetchImpl, { timeoutMs: 5 });

    await expect(http.request('/slow')).rejects.toBeInstanceOf(PluggyTransportError);
    await expect(http.request('/items', { method: 'PATCH' })).rejects.toMatchObject({
      status: 503,
    });
    expect(dataCalls).toBe(2);
  });
});

describe('legacy webhook normalization', () => {
  it('constructs a V2 cursor input from validated legacy account and timestamp evidence', () => {
    const timestamp = '2026-08-23T12:00:00.000Z';
    const result = normalizePluggyCreatedTransactionsHint({
      accountId,
      transactionsCreatedAtFrom: timestamp,
      createdTransactionsLink: `https://api.pluggy.ai/transactions?accountId=${accountId}&createdAtFrom=${timestamp}`,
    });

    expect(result.externalAccountId).toBe(accountId);
    expect(result.cursor).toContain(`accountId=${accountId}`);
    expect(result.cursor).toContain('createdAtFrom=2026-08-23T12%3A00%3A00.000Z');
  });

  it('rejects mismatched, foreign-origin, and malformed webhook evidence', () => {
    const timestamp = '2026-08-23T12:00:00.000Z';
    expect(() =>
      normalizePluggyCreatedTransactionsHint({
        accountId,
        transactionsCreatedAtFrom: timestamp,
        createdTransactionsLink: `https://example.com/transactions?accountId=${accountId}&createdAtFrom=${timestamp}`,
      }),
    ).toThrow(/unexpected origin or path/u);
    expect(() =>
      normalizePluggyCreatedTransactionsHint({
        accountId,
        transactionsCreatedAtFrom: timestamp,
        createdTransactionsLink: `https://api.pluggy.ai/transactions?accountId=${itemId}&createdAtFrom=${timestamp}`,
      }),
    ).toThrow(/does not match/u);
  });
});
