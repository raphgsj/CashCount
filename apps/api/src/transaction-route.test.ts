import { Buffer } from 'node:buffer';

import {
  TransactionUserStateConflictError,
  type TransactionApiRecord,
} from '@cashcount/db/finance';
import { describe, expect, it, vi } from 'vitest';

import {
  processTransactionRequest,
  type TransactionRouteDependencies,
  type TransactionRouteRepository,
} from './transaction-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000062';
const transactionId = '20000000-0000-4000-8000-000000000062';
const accountId = '30000000-0000-4000-8000-000000000062';
const categoryId = '40000000-0000-4000-8000-000000000062';
const tagId = '50000000-0000-4000-8000-000000000062';
const webToken = Buffer.alloc(32, 80).toString('base64url');
const requestId = '60000000-0000-4000-8000-000000000062';

function transaction(overrides: Partial<TransactionApiRecord> = {}): TransactionApiRecord {
  return {
    accountCurrency: 'BRL',
    accountCurrencyAmountSigned: '-10.100001',
    accountId,
    accountMaskedNumber: '1234',
    accountName: 'Synthetic Checking',
    accountType: 'CHECKING',
    analyticsAmountSigned: '-10.100001',
    analyticsCurrency: 'BRL',
    billCloseDate: null,
    billDueDate: null,
    billForecastMonth: null,
    billId: null,
    billStatus: null,
    cardLastFour: null,
    categoryOverrideEnabled: false,
    description: 'Synthetic purchase',
    duplicateReviewStatus: 'NONE',
    effectiveCategoryId: categoryId,
    effectiveCategoryName: 'Compras',
    effectiveCategorySource: 'RULE',
    effectiveExclusionSource: 'POLICY',
    effectiveFinancialRole: 'PURCHASE',
    effectiveFinancialRoleSource: 'HEURISTIC',
    effectiveIsExcludedFromSpend: false,
    effectiveLastSuccessfulSyncAt: new Date('2026-08-26T12:00:00Z'),
    effectiveMerchantId: null,
    effectiveMerchantName: null,
    effectiveMerchantSource: 'NONE',
    financialRoleOverrideEnabled: false,
    hasUnconvertedCurrency: false,
    historyCoverageStatus: 'PARTIAL',
    historyEarliestDate: '2026-01-01',
    id: transactionId,
    installmentNumber: null,
    installmentTotal: null,
    installmentTotalAmount: null,
    isStale: false,
    localDate: '2026-08-26',
    merchantOverrideEnabled: false,
    notes: null,
    payeeMcc: null,
    providerAmountSigned: '-10.100001',
    providerCurrency: 'BRL',
    providerPurchaseAt: null,
    providerTransactionAt: new Date('2026-08-26T12:00:00Z'),
    purchaseLocalDate: null,
    replacementContext: [],
    requiresConnectionAttention: false,
    reviewStatus: 'UNREVIEWED',
    status: 'POSTED',
    tags: [],
    userStateVersion: 0,
    warnings: [],
    ...overrides,
  };
}

function repository(): TransactionRouteRepository {
  return {
    get: vi.fn(async () => transaction()),
    list: vi.fn(async () => ({ items: [transaction()], nextCursor: null, warnings: [] })),
    update: vi.fn(async () => transaction({ userStateVersion: 1 })),
  };
}

function dependencies(repo = repository()): TransactionRouteDependencies {
  return {
    actorId: 'service_web',
    now: () => new Date('2026-08-26T13:00:00Z'),
    repository: repo,
    requestId: () => requestId,
    webToken,
    workspaceId,
  };
}

function request(method: string, path: string, body?: unknown, token = webToken) {
  return {
    authorizationHeader: `Bearer ${token}`,
    body,
    hasBody: body !== undefined,
    method,
    url: new URL(path, 'http://cashcount.invalid'),
  };
}

describe('transaction route', () => {
  it('lists exact signed values with filter-bound stable cursors', async () => {
    const repo = repository();
    repo.list = vi.fn(async () => ({
      items: [transaction()],
      nextCursor: { id: transactionId, localDate: '2026-08-26' },
      warnings: [],
    }));
    const first = await processTransactionRequest(
      request('GET', '/v1/transactions?from=2026-08-01&to=2026-08-31&limit=1'),
      dependencies(repo),
    );
    expect(first?.status).toBe(200);
    expect(first?.body).toMatchObject({
      data: {
        items: [
          {
            analyticsAmount: { currency: 'BRL', value: '-10.100001' },
            originalAmount: { currency: 'BRL', value: '-10.100001' },
          },
        ],
      },
    });
    const cursor = (first?.body as { data: { page: { nextCursor: string } } }).data.page.nextCursor;
    const second = await processTransactionRequest(
      request('GET', `/v1/transactions?from=2026-08-01&to=2026-08-31&limit=1&cursor=${cursor}`),
      dependencies(repo),
    );
    expect(second?.status).toBe(200);
    expect(repo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: { id: transactionId, localDate: '2026-08-26' } }),
    );

    const changedFilter = await processTransactionRequest(
      request('GET', `/v1/transactions?from=2026-08-01&to=2026-08-30&limit=1&cursor=${cursor}`),
      dependencies(repo),
    );
    expect(changedFilter?.status).toBe(400);
    expect(changedFilter?.body).toMatchObject({ code: 'INVALID_CURSOR' });
  });

  it('returns detail provenance, owner state, and structured warnings', async () => {
    const repo = repository();
    repo.get = vi.fn(async () =>
      transaction({
        effectiveCategoryId: null,
        effectiveCategoryName: null,
        categoryOverrideEnabled: true,
        description: 'PIX CPF 123.456.789-09 CARD 4111111111111111',
        notes: 'Owner-only note',
        warnings: [
          {
            accountCurrency: 'BRL',
            accountId,
            code: 'UNCONVERTED_CURRENCY',
            originalCurrency: 'USD',
          },
        ],
      }),
    );
    const result = await processTransactionRequest(
      request('GET', `/v1/transactions/${transactionId}`),
      dependencies(repo),
    );
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({
      data: {
        effective: { category: { override: { mode: 'CLEAR' }, value: null } },
        notes: 'Owner-only note',
      },
      meta: { warnings: [{ code: 'UNCONVERTED_CURRENCY' }], workspaceId },
    });
    expect(JSON.stringify(result?.body)).not.toMatch(/123\.456\.789-09|4111111111111111/u);
    expect(JSON.stringify(result?.body)).toContain('••••1111');
  });

  it('maps explicit patches and stale versions without accepting provider-owned fields', async () => {
    const repo = repository();
    const result = await processTransactionRequest(
      request('PATCH', `/v1/transactions/${transactionId}`, {
        categoryOverride: { categoryId, mode: 'SET' },
        expectedVersion: 0,
        notes: 'Checked',
        tagIds: [tagId],
      }),
      dependencies(repo),
    );
    expect(result?.status).toBe(200);
    expect(repo.update).toHaveBeenCalledWith({
      actorId: 'service_web',
      categoryOverride: { mode: 'SET', value: categoryId },
      expectedVersion: 0,
      notes: 'Checked',
      tagIds: [tagId],
      transactionId,
      workspaceId,
    });

    const invalid = await processTransactionRequest(
      request('PATCH', `/v1/transactions/${transactionId}`, {
        expectedVersion: 1,
        providerAmountSigned: '999.00',
      }),
      dependencies(repo),
    );
    expect(invalid?.status).toBe(400);

    repo.update = vi.fn(async () => {
      throw new TransactionUserStateConflictError(0, 2);
    });
    const conflict = await processTransactionRequest(
      request('PATCH', `/v1/transactions/${transactionId}`, {
        expectedVersion: 0,
        reviewStatus: 'CONFIRMED',
      }),
      dependencies(repo),
    );
    expect(conflict?.status).toBe(409);
    expect(conflict?.body).toMatchObject({ actualVersion: 2, code: 'VERSION_CONFLICT' });
  });

  it('requires the web-owner credential and bounded list inputs', async () => {
    const repo = repository();
    const unauthorized = await processTransactionRequest(
      request(
        'GET',
        '/v1/transactions?from=2026-08-01&to=2026-08-31',
        undefined,
        Buffer.alloc(32, 81).toString('base64url'),
      ),
      dependencies(repo),
    );
    expect(unauthorized?.status).toBe(401);
    expect(repo.list).not.toHaveBeenCalled();

    for (const query of [
      'from=2026-08-31&to=2026-08-01',
      'from=2025-01-01&to=2026-08-01',
      'from=2026-08-01&to=2026-08-31&workspaceId=bad',
    ]) {
      const invalid = await processTransactionRequest(
        request('GET', `/v1/transactions?${query}`),
        dependencies(repo),
      );
      expect(invalid?.status).toBe(400);
    }
  });
});
