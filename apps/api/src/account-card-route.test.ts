import { Buffer } from 'node:buffer';

import { describe, expect, it, vi } from 'vitest';

import {
  processAccountCardRequest,
  type AccountCardRouteDependencies,
  type AccountCardRouteRepository,
} from './account-card-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000061';
const accountId = '20000000-0000-4000-8000-000000000061';
const cardId = '30000000-0000-4000-8000-000000000061';
const billId = '40000000-0000-4000-8000-000000000061';
const webToken = Buffer.alloc(32, 81).toString('base64url');
const mcpToken = Buffer.alloc(32, 82).toString('base64url');

const account = {
  accountSubtype: null,
  accountType: 'CHECKING' as const,
  availableBalance: '900.123456',
  availableCreditLimit: null,
  closingDay: null,
  creditLimit: null,
  currency: 'BRL',
  currentBalance: '1000.123456',
  dueDay: null,
  historyCoverageStatus: 'PARTIAL' as const,
  id: accountId,
  institutionName: 'Synthetic Bank',
  isActive: true,
  lastSuccessfulSyncAt: new Date('2026-08-24T12:00:00Z'),
  maskedNumber: '1234',
  name: 'Synthetic Checking',
  providerHistoryEarliestDate: '2026-01-01',
  providerHistoryLatestDate: '2026-08-24',
};
const card = {
  ...account,
  accountType: 'CREDIT_CARD' as const,
  availableBalance: null,
  availableCreditLimit: '7000.000001',
  closingDay: 20,
  creditLimit: '10000.000001',
  currentBalance: '-3000.000001',
  dueDay: 28,
  id: cardId,
  name: 'Synthetic Card',
};
const bill = {
  allowsInstallments: true,
  cardId,
  closeDate: '2026-08-20',
  currency: 'BRL',
  dueDate: '2026-08-28',
  id: billId,
  minimumPayment: '100.000001',
  status: 'OPEN',
  totalAmount: '1000.000001',
};

function repository(): AccountCardRouteRepository {
  return {
    getAccount: vi.fn(async () => account),
    getCard: vi.fn(async () => card),
    getCardBill: vi.fn(async () => bill),
    listAccounts: vi.fn(async () => [account, card]),
    listBillFinanceCharges: vi.fn(async () => [
      {
        additionalInfo: null,
        amount: '10.000001',
        chargeType: 'IOF',
        currency: 'BRL',
        id: '50000000-0000-4000-8000-000000000061',
        isMatchedToTransaction: false,
      },
    ]),
    listBillPayments: vi.fn(async () => [
      {
        amount: '1000.000001',
        currency: 'BRL',
        id: '60000000-0000-4000-8000-000000000061',
        isMatchedToCardTransaction: false,
        paymentDate: '2026-08-27',
        paymentMode: 'PIX',
        valueType: 'FULL_PAYMENT',
      },
    ]),
    listCardBills: vi.fn(async () => [bill]),
    listCards: vi.fn(async () => [card]),
  };
}

function dependencies(repo = repository()): AccountCardRouteDependencies {
  return {
    now: () => new Date('2026-08-24T15:00:00Z'),
    repository: repo,
    requestId: () => '70000000-0000-4000-8000-000000000061',
    webToken,
    workspaceId,
  };
}

function request(path: string, token = webToken, method = 'GET') {
  return {
    authorizationHeader: `Bearer ${token}`,
    hasBody: false,
    method,
    url: new URL(path, 'https://api.cashcount.test'),
  };
}

describe('account/card routes', () => {
  it('returns bounded exact account and card lists in the configured workspace', async () => {
    const repo = repository();
    const accounts = await processAccountCardRequest(
      request('/v1/accounts?limit=25'),
      dependencies(repo),
    );
    expect(repo.listAccounts).toHaveBeenCalledWith(workspaceId, 25);
    expect(accounts).toMatchObject({
      body: {
        data: {
          limit: 25,
        },
        meta: { workspaceId },
      },
      status: 200,
    });
    expect((accounts?.body as { data: { items: unknown[] } }).data.items[0]).toMatchObject({
      currentBalance: { currency: 'BRL', value: '1000.123456' },
    });

    const cards = await processAccountCardRequest(request('/v1/cards'), dependencies(repo));
    expect(cards).toMatchObject({
      body: {
        data: {
          items: [
            {
              accountType: 'CREDIT_CARD',
              creditLimit: { currency: 'BRL', value: '10000.000001' },
            },
          ],
        },
      },
      status: 200,
    });
  });

  it('returns bill, payment, and finance-charge evidence without provider identities', async () => {
    const config = dependencies();
    for (const path of [
      `/v1/cards/${cardId}/bills`,
      `/v1/card-bills/${billId}`,
      `/v1/card-bills/${billId}/payments`,
      `/v1/card-bills/${billId}/finance-charges`,
    ]) {
      const result = await processAccountCardRequest(request(path), config);
      expect(result).toMatchObject({ status: 200 });
      expect(JSON.stringify(result)).not.toMatch(/external|rawObject|providerId/iu);
    }
  });

  it('rejects MCP substitution, caller scope, bodies, invalid IDs, and mutations before reads', async () => {
    const repo = repository();
    const config = dependencies(repo);
    await expect(
      processAccountCardRequest(request('/v1/accounts', mcpToken), config),
    ).resolves.toMatchObject({ status: 401 });
    await expect(
      processAccountCardRequest(request('/v1/accounts?workspaceId=attacker'), config),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      processAccountCardRequest({ ...request('/v1/accounts'), hasBody: true }, config),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      processAccountCardRequest(request('/v1/accounts/not-a-uuid'), config),
    ).resolves.toMatchObject({ status: 400 });
    await expect(
      processAccountCardRequest(request('/v1/cards', webToken, 'POST'), config),
    ).resolves.toMatchObject({ headers: { allow: 'GET' }, status: 405 });
    expect(repo.listAccounts).not.toHaveBeenCalled();
  });

  it('maps same-workspace missing resources to bounded not-found problems', async () => {
    const repo = repository();
    repo.getAccount = vi.fn(async () => null);
    repo.listCardBills = vi.fn(async () => null);
    await expect(
      processAccountCardRequest(request(`/v1/accounts/${accountId}`), dependencies(repo)),
    ).resolves.toMatchObject({ body: { code: 'NOT_FOUND' }, status: 404 });
    await expect(
      processAccountCardRequest(request(`/v1/cards/${cardId}/bills`), dependencies(repo)),
    ).resolves.toMatchObject({ body: { code: 'NOT_FOUND' }, status: 404 });
  });
});
