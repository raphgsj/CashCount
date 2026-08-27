import { Buffer } from 'node:buffer';

import type { InstallmentCommitmentsResult } from '@cashcount/analytics';
import { describe, expect, it, vi } from 'vitest';

import {
  processInstallmentRequest,
  type InstallmentRouteDependencies,
  type InstallmentRouteRepository,
} from './installment-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000067';
const cardId = '20000000-0000-4000-8000-000000000067';
const requestId = '30000000-0000-4000-8000-000000000067';
const webToken = Buffer.alloc(32, 73).toString('base64url');
const mcpToken = Buffer.alloc(32, 74).toString('base64url');

function repository(): InstallmentRouteRepository {
  return {
    list: vi.fn(async (): Promise<InstallmentCommitmentsResult> => ({
      freshness: {
        isStale: false,
        lastSuccessfulSyncAt: new Date('2026-08-27T00:00:00Z'),
        oldestAccountSyncAt: new Date('2026-08-27T00:00:00Z'),
        staleAfterMinutes: 1440,
      },
      includeReviewStates: false,
      monthly: [
        {
          currency: 'BRL',
          estimatedAmount: '100.000001',
          estimatedInstallmentCount: 1,
          month: '2026-09-01' as InstallmentCommitmentsResult['monthly'][number]['month'],
        },
      ],
      policyVersion: 1,
      series: [
        {
          currency: 'BRL',
          estimatedInstallmentAmount: '100.000001',
          estimatedNextMonth:
            '2026-09-01' as InstallmentCommitmentsResult['series'][number]['estimatedNextMonth'],
          estimatedRemainingCommitment: '300.000003',
          highestConfirmedInstallment: 3,
          merchantLabel: 'Synthetic Store',
          originalTotalAmount: '600.000006',
          purchaseDate:
            '2026-06-10' as InstallmentCommitmentsResult['series'][number]['purchaseDate'],
          remainingInstallments: 3,
          status: 'CONFIRMED',
          totalInstallments: 6,
        },
      ],
      warnings: [{ assumption: 'MONTHLY_FROM_PURCHASE_DATE', code: 'ESTIMATED_COMMITMENTS' }],
    })),
  };
}

function dependencies(repo = repository()): InstallmentRouteDependencies {
  return {
    mcpToken,
    now: () => new Date('2026-08-27T00:30:00Z'),
    repository: repo,
    requestId: () => requestId,
    webToken,
    workspaceId,
  };
}

function request(path: string, token: string, method = 'GET', hasBody = false) {
  return {
    authorizationHeader: `Bearer ${token}`,
    hasBody,
    method,
    url: new URL(path, 'http://cashcount.invalid'),
  };
}

describe('installment commitments route', () => {
  it('returns confirmed estimate components to independent web/MCP readers', async () => {
    for (const token of [webToken, mcpToken]) {
      const result = await processInstallmentRequest(
        request('/v1/analytics/installment-commitments', token),
        dependencies(),
      );
      expect(result?.status).toBe(200);
      expect(result?.body).toMatchObject({
        data: {
          monthly: [{ estimatedAmount: { value: '100.000001' } }],
          series: [{ estimatedRemainingCommitment: { value: '300.000003' } }],
        },
        meta: { policyVersion: 1, workspaceId },
        warnings: [{ code: 'ESTIMATED_COMMITMENTS' }],
      });
    }
  });

  it('keeps card review-state reads web-only and fixed-workspace scoped', async () => {
    const repo = repository();
    expect(
      (
        await processInstallmentRequest(
          request(`/v1/cards/${cardId}/installments`, webToken),
          dependencies(repo),
        )
      )?.status,
    ).toBe(200);
    expect(repo.list).toHaveBeenCalledWith(workspaceId, { cardId, includeReviewStates: true });
    expect(
      (
        await processInstallmentRequest(
          request(`/v1/cards/${cardId}/installments`, mcpToken),
          dependencies(),
        )
      )?.status,
    ).toBe(401);
  });

  it('rejects mutation, caller scope, body, malformed IDs, and unrelated paths', async () => {
    for (const input of [
      request('/v1/analytics/installment-commitments', webToken, 'POST'),
      request('/v1/analytics/installment-commitments?workspaceId=bad', webToken),
      request('/v1/analytics/installment-commitments', webToken, 'GET', true),
      request('/v1/cards/bad/installments', webToken),
    ]) {
      expect((await processInstallmentRequest(input, dependencies()))?.status).not.toBe(200);
    }
    expect(
      await processInstallmentRequest(request('/v1/unrelated', webToken), dependencies()),
    ).toBeNull();
  });
});
