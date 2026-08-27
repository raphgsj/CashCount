import { Buffer } from 'node:buffer';

import type {
  BillPaymentReconciliationCandidate,
  CardBillReconciliationSummary,
} from '@cashcount/db/finance';
import { describe, expect, it, vi } from 'vitest';

import {
  processBillReconciliationRequest,
  type BillReconciliationRouteDependencies,
  type BillReconciliationRouteRepository,
} from './bill-reconciliation-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000066';
const billId = '20000000-0000-4000-8000-000000000066';
const paymentId = '30000000-0000-4000-8000-000000000066';
const candidateId = '40000000-0000-4000-8000-000000000066';
const transactionId = '50000000-0000-4000-8000-000000000066';
const requestId = '60000000-0000-4000-8000-000000000066';
const webToken = Buffer.alloc(32, 70).toString('base64url');
const mcpToken = Buffer.alloc(32, 71).toString('base64url');

const candidate: BillPaymentReconciliationCandidate = {
  amount: '100.000001',
  confidence: '1.0000',
  currency: 'BRL',
  description: 'Pagamento 12345678901',
  id: candidateId,
  matchStatus: 'CANDIDATE',
  transactionDate: '2026-08-20',
  transactionId,
};

const summary: CardBillReconciliationSummary = {
  billId,
  billStatus: 'OPEN',
  cardId: '70000000-0000-4000-8000-000000000066',
  closeDate: '2026-08-20',
  confirmedBankPaymentCount: 0,
  confirmedBankPaymentTotal: '0.000000',
  currency: 'BRL',
  differenceAmount: '5.000001',
  dueDate: '2026-08-30',
  financeChargeTotal: '5.000000',
  lastSuccessfulSyncAt: new Date('2026-08-27T00:00:00Z'),
  linkedTransactionTotal: '95.000000',
  normalizedPaymentTotal: '100.000001',
  pendingPurchaseTotal: '10.000000',
  policyVersion: 1,
  postedNetSpendingTotal: '95.000000',
  providerBillTotal: '100.000001',
  reconciliationStatus: 'NEEDS_REVIEW',
  toleranceAmount: '0.010000',
  unresolvedItemCount: 1,
  unconvertedTransactionCount: 0,
};

function repository(): BillReconciliationRouteRepository {
  return {
    confirmCandidate: vi.fn(async (): Promise<BillPaymentReconciliationCandidate> => ({
      ...candidate,
      matchStatus: 'USER_CONFIRMED',
    })),
    generateCandidates: vi.fn(async () => [candidate]),
    getSummary: vi.fn(async () => summary),
    rejectCandidate: vi.fn(async (): Promise<BillPaymentReconciliationCandidate> => ({
      ...candidate,
      matchStatus: 'REJECTED',
    })),
  };
}

function dependencies(repo = repository()): BillReconciliationRouteDependencies {
  return {
    mcpToken,
    now: () => new Date('2026-08-27T00:30:00Z'),
    repository: repo,
    requestId: () => requestId,
    webToken,
    workspaceId,
  };
}

function request(path: string, token: string, method: string, body?: unknown) {
  return {
    authorizationHeader: `Bearer ${token}`,
    body,
    method,
    url: new URL(path, 'http://cashcount.invalid'),
  };
}

describe('bill reconciliation route', () => {
  it('returns an exact bounded bill summary to web and MCP without private evidence', async () => {
    for (const token of [webToken, mcpToken]) {
      const result = await processBillReconciliationRequest(
        request(`/v1/card-bills/${billId}/reconciliation`, token, 'GET'),
        dependencies(),
      );
      expect(result?.status).toBe(200);
      expect(result?.body).toMatchObject({
        data: {
          differenceAmount: { currency: 'BRL', value: '5.000001' },
          reconciliationStatus: 'NEEDS_REVIEW',
        },
        meta: { policyVersion: 1, workspaceId },
        warnings: [{ code: 'UNRECONCILED_BILL' }],
      });
    }
  });

  it('generates masked candidates and permits only web-owner resolution commands', async () => {
    const repo = repository();
    const generated = await processBillReconciliationRequest(
      request(`/v1/bill-payments/${paymentId}/reconciliation-candidates`, webToken, 'POST', {}),
      dependencies(repo),
    );
    expect(generated?.status).toBe(200);
    expect(JSON.stringify(generated?.body)).not.toContain('12345678901');
    expect(repo.generateCandidates).toHaveBeenCalledWith(workspaceId, paymentId);

    for (const [path, method] of [
      [`/v1/bill-payments/${paymentId}/confirm-reconciliation`, 'confirmCandidate'],
      [`/v1/bill-payments/${paymentId}/reject-reconciliation`, 'rejectCandidate'],
    ] as const) {
      const result = await processBillReconciliationRequest(
        request(path, webToken, 'POST', { actorId: 'synthetic-owner', candidateId }),
        dependencies(repo),
      );
      expect(result?.status).toBe(200);
      expect(repo[method]).toHaveBeenCalledWith(
        workspaceId,
        paymentId,
        candidateId,
        'synthetic-owner',
      );
      expect(
        (
          await processBillReconciliationRequest(
            request(path, mcpToken, 'POST', { actorId: 'synthetic-owner', candidateId }),
            dependencies(),
          )
        )?.status,
      ).toBe(401);
    }
  });

  it('rejects malformed IDs, methods, bodies, queries, and credentials', async () => {
    expect(
      (
        await processBillReconciliationRequest(
          request('/v1/card-bills/bad/reconciliation', webToken, 'GET'),
          dependencies(),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await processBillReconciliationRequest(
          request(`/v1/card-bills/${billId}/reconciliation?workspaceId=bad`, webToken, 'GET'),
          dependencies(),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await processBillReconciliationRequest(
          request(`/v1/card-bills/${billId}/reconciliation`, webToken, 'POST'),
          dependencies(),
        )
      )?.status,
    ).toBe(405);
    expect(
      (
        await processBillReconciliationRequest(
          request(`/v1/bill-payments/${paymentId}/confirm-reconciliation`, webToken, 'POST', {}),
          dependencies(),
        )
      )?.status,
    ).toBe(400);
    expect(
      (
        await processBillReconciliationRequest(
          request(
            `/v1/card-bills/${billId}/reconciliation`,
            Buffer.alloc(32, 72).toString('base64url'),
            'GET',
          ),
          dependencies(),
        )
      )?.status,
    ).toBe(401);
  });
});
