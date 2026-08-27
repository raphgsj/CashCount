import { Buffer } from 'node:buffer';

import type { SpendingCashFlowResult } from '@cashcount/analytics';

import type { AnalyticsRouteRepository, AnalyticsRouteDependencies } from './analytics-route.js';
import { processAnalyticsRequest } from './analytics-route.js';
import { describe, expect, it, vi } from 'vitest';

const workspaceId = '10000000-0000-4000-8000-000000000064';
const accountId = '20000000-0000-4000-8000-000000000064';
const categoryId = '30000000-0000-4000-8000-000000000064';
const webToken = Buffer.alloc(32, 64).toString('base64url');
const mcpToken = Buffer.alloc(32, 65).toString('base64url');
const webhookToken = Buffer.alloc(32, 66).toString('base64url');
const requestId = '40000000-0000-4000-8000-000000000064';

function repository(): AnalyticsRouteRepository {
  return {
    summarize: vi.fn(async (): Promise<SpendingCashFlowResult> => ({
      categoryBreakdown: [],
      freshness: {
        isStale: false,
        lastSuccessfulSyncAt: new Date('2026-08-27T00:00:00Z'),
        oldestAccountSyncAt: new Date('2026-08-26T23:00:00Z'),
        staleAfterMinutes: 1440 as const,
      },
      from: '2026-08-01' as SpendingCashFlowResult['from'],
      granularity: 'MONTH' as const,
      includePending: false,
      merchantBreakdown: [],
      policyVersion: 1,
      timeSeries: [],
      to: '2026-08-31' as SpendingCashFlowResult['to'],
      totals: [
        {
          cashFlow: {
            inflowTotal: '1000.000001',
            netCashFlow: '900.000000',
            outflowTotal: '100.000001',
            transactionCount: 2,
          },
          currency: 'BRL',
          spending: {
            grossSpending: '120.000001',
            netSpending: '110.000001',
            refundTotal: '10.000000',
            transactionCount: 2,
          },
          status: 'POSTED' as const,
        },
      ],
      warnings: [{ code: 'UNCONVERTED_CURRENCY' as const, excludedTransactionCount: 1 }],
    })),
  };
}

function dependencies(repo = repository()): AnalyticsRouteDependencies {
  return {
    mcpToken,
    now: () => new Date('2026-08-27T00:30:00Z'),
    repository: repo,
    requestId: () => requestId,
    webToken,
    workspaceId,
  };
}

function request(path: string, token = webToken, method = 'GET', hasBody = false) {
  return {
    authorizationHeader: `Bearer ${token}`,
    hasBody,
    method,
    url: new URL(path, 'http://cashcount.invalid'),
  };
}

describe('analytics route', () => {
  it('returns separate exact spending and cash-flow metrics in the analytics envelope', async () => {
    const repo = repository();
    const result = await processAnalyticsRequest(
      request('/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31'),
      dependencies(repo),
    );
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({
      data: {
        totals: [
          {
            cashFlow: { netCashFlow: '900.000000' },
            spending: { netSpending: '110.000001' },
          },
        ],
      },
      freshness: { isStale: false, staleAfterMinutes: 1440 },
      meta: { policyVersion: 1, requestId, workspaceId },
      warnings: [{ code: 'UNCONVERTED_CURRENCY' }],
    });
    expect(repo.summarize).toHaveBeenCalledWith(workspaceId, {
      from: '2026-08-01',
      to: '2026-08-31',
    });
  });

  it('accepts web-owner and MCP read-only credentials on only the bounded read route', async () => {
    for (const token of [webToken, mcpToken]) {
      expect(
        (
          await processAnalyticsRequest(
            request('/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31', token),
            dependencies(),
          )
        )?.status,
      ).toBe(200);
    }
    for (const token of [webhookToken, Buffer.alloc(32, 67).toString('base64url')]) {
      expect(
        (
          await processAnalyticsRequest(
            request('/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31', token),
            dependencies(),
          )
        )?.status,
      ).toBe(401);
    }
    expect(
      (
        await processAnalyticsRequest(
          request('/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31', mcpToken, 'POST'),
          dependencies(),
        )
      )?.status,
    ).toBe(405);
  });

  it('maps allow-listed filters and keeps pending explicit', async () => {
    const repo = repository();
    const result = await processAnalyticsRequest(
      request(
        `/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31` +
          `&accountId=${accountId}&categoryId=${categoryId}` +
          '&includePending=true&granularity=DAY',
      ),
      dependencies(repo),
    );
    expect(result?.status).toBe(200);
    expect(repo.summarize).toHaveBeenCalledWith(workspaceId, {
      accountId,
      categoryId,
      from: '2026-08-01',
      granularity: 'DAY',
      includePending: true,
      to: '2026-08-31',
    });
  });

  it('rejects unbounded, duplicate, caller-scoped, malformed, and body-bearing queries', async () => {
    for (const path of [
      '/v1/analytics/spending-summary',
      '/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31&workspaceId=bad',
      '/v1/analytics/spending-summary?from=2026-08-01&from=2026-08-02&to=2026-08-31',
      '/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31&includePending=1',
      '/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31&granularity=YEAR',
      '/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31&accountId=bad',
    ]) {
      expect((await processAnalyticsRequest(request(path), dependencies()))?.status).toBe(400);
    }
    expect(
      (
        await processAnalyticsRequest(
          request(
            '/v1/analytics/spending-summary?from=2026-08-01&to=2026-08-31',
            webToken,
            'GET',
            true,
          ),
          dependencies(),
        )
      )?.status,
    ).toBe(400);
  });
});
