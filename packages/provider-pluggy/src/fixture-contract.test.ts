import {
  pluggyAccountBody,
  pluggyBillsBody,
  pluggyFixtureIds,
  pluggyHistoryPages,
  pluggyItemLifecycleFixtures,
  pluggyReplacementFixture,
  pluggyTransactionMatrixBody,
  pluggyTransactionMatrixExpected,
} from '@cashcount/test-fixtures';
import { describe, expect, it, vi } from 'vitest';

import {
  normalizePluggyCreatedTransactionsHint,
  PluggyApiKeyProvider,
  PluggyAuthenticatedHttpClient,
  PluggyDataClient,
} from './index.js';

function response(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' }, status: 200 });
}

function clientFor(fetchImpl: typeof fetch): PluggyDataClient {
  const keyProvider = new PluggyApiKeyProvider({
    baseUrl: 'https://api.pluggy.ai',
    clientId: 'synthetic-client-id',
    clientSecret: 'synthetic-client-secret',
    fetchImpl,
    requestId: () => 'fixture-auth-request',
  });
  return new PluggyDataClient({
    httpClient: new PluggyAuthenticatedHttpClient({
      apiKeyProvider: keyProvider,
      baseUrl: 'https://api.pluggy.ai',
      fetchImpl,
      requestId: () => 'fixture-data-request',
    }),
  });
}

function authOr(body: string, pathname: string, input: Parameters<typeof fetch>[0]): Response {
  return new URL(String(input)).pathname === '/auth'
    ? response('{"accessToken":"synthetic-test-key"}')
    : new URL(String(input)).pathname === pathname
      ? response(body)
      : response('{"unexpected":true}');
}

describe('Pluggy sanitized fixture contracts', () => {
  it.each(pluggyItemLifecycleFixtures)('maps $name to $expectedLocalStatus', async (fixture) => {
    const pathname = `/items/${pluggyFixtureIds.connection}`;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => authOr(fixture.responseBody, pathname, input));

    const connection = await clientFor(fetchImpl).getConnection(pluggyFixtureIds.connection);

    expect(connection.localStatus).toBe(fixture.expectedLocalStatus);
    expect(connection.errorCode).toBe(
      (JSON.parse(fixture.responseBody) as { error: null | { code: string } }).error?.code ?? null,
    );
  });

  it('maps signs, currencies, conversion evidence, and nullable enrichment losslessly', async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      paths.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/auth') return response('{"accessToken":"synthetic-test-key"}');
      if (url.pathname === `/accounts/${pluggyFixtureIds.account}`) {
        return response(pluggyAccountBody);
      }
      if (url.pathname === '/v2/transactions') return response(pluggyTransactionMatrixBody);
      return response('{"unexpected":true}');
    });

    const page = await clientFor(fetchImpl).listTransactions({
      cursor: null,
      externalAccountId: pluggyFixtureIds.account,
    });

    expect(
      page.items.map((item) => ({
        amountInAccountCurrencySigned: item.amountInAccountCurrencySigned,
        amountSigned: item.amountSigned,
        currency: item.currency,
        merchantName: item.merchant?.name ?? null,
        providerType: item.providerType,
      })),
    ).toEqual(pluggyTransactionMatrixExpected);
    expect(page.items[2]?.creditCardMetadata).toMatchObject({
      billForecastMonth: '2026-09',
      cardLastFour: '0099',
      installmentNumber: 2,
      totalAmount: '123.456789',
      totalInstallments: 10,
    });
    expect(page.items[3]).toMatchObject({
      categoryId: null,
      categoryName: null,
      descriptionRaw: null,
      merchant: null,
      status: 'UNKNOWN',
    });
    expect(paths.some((path) => path.startsWith('/v2/transactions?'))).toBe(true);
    expect(paths.some((path) => path.startsWith('/transactions?'))).toBe(false);
  });

  it('maps bill children as evidence without inventing missing values', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) => authOr(pluggyBillsBody, '/bills', input));

    const bills = await clientFor(fetchImpl).listCreditCardBills(pluggyFixtureIds.account);

    expect(bills).toMatchObject([
      {
        allowsInstallments: true,
        closeDate: '2026-09-10',
        financeCharges: [{ additionalInfo: null, amount: '50.4', chargeType: 'IOF' }],
        minimumPayment: null,
        payments: [{ amount: '1200', paymentMode: null }],
        totalAmount: '1250.4',
      },
    ]);
  });

  it('walks cursor history and exposes only observed bounds to later coverage policy', async () => {
    let pageIndex = 0;
    const requestedPaths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      requestedPaths.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/auth') return response('{"accessToken":"synthetic-test-key"}');
      if (url.pathname === `/accounts/${pluggyFixtureIds.account}`) {
        return response(pluggyAccountBody);
      }
      if (url.pathname === '/v2/transactions') {
        const fixture = pluggyHistoryPages[pageIndex];
        pageIndex += 1;
        return response(fixture?.responseBody ?? '{"results":[],"next":null}');
      }
      return response('{"unexpected":true}');
    });
    const client = clientFor(fetchImpl);

    const first = await client.listTransactions({
      cursor: null,
      externalAccountId: pluggyFixtureIds.account,
    });
    const last = await client.listTransactions({
      cursor: first.nextCursor,
      externalAccountId: pluggyFixtureIds.account,
    });

    expect(first.items[0]?.transactionAt.slice(0, 10)).toBe(
      pluggyHistoryPages[0].expectedObservedDate,
    );
    expect(last.items[0]?.transactionAt.slice(0, 10)).toBe(
      pluggyHistoryPages[1].expectedObservedDate,
    );
    expect(last.nextCursor).toBeNull();
    expect(requestedPaths.filter((path) => path.startsWith('/v2/transactions'))).toHaveLength(2);
    expect(requestedPaths.some((path) => path.startsWith('/transactions'))).toBe(false);
  });

  it('preserves distinct replacement IDs and prefers the V2 webhook link', () => {
    const predecessor = JSON.parse(pluggyReplacementFixture.predecessorBody) as { id: string };
    const successor = JSON.parse(pluggyReplacementFixture.successorBody) as { id: string };
    const deleted = JSON.parse(pluggyReplacementFixture.deletedWebhookBody) as {
      transactionIds: string[];
    };

    expect(predecessor.id).not.toBe(successor.id);
    expect(deleted.transactionIds).toEqual([predecessor.id]);
    expect(
      normalizePluggyCreatedTransactionsHint(pluggyReplacementFixture.createdWebhookHint),
    ).toEqual({
      cursor: `?accountId=${pluggyFixtureIds.account}&createdAtFrom=2026-08-23T12%3A00%3A00.000Z&after=replacement-cursor`,
      externalAccountId: pluggyFixtureIds.account,
    });
  });
});
