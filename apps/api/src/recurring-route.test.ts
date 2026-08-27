import { Buffer } from 'node:buffer';

import type { RecurringSeriesResult } from '@cashcount/db/finance';
import { describe, expect, it, vi } from 'vitest';

import {
  processRecurringRequest,
  type RecurringRouteDependencies,
  type RecurringRouteRepository,
} from './recurring-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000068';
const seriesId = '20000000-0000-4000-8000-000000000068';
const requestId = '30000000-0000-4000-8000-000000000068';
const webToken = Buffer.alloc(32, 75).toString('base64url');
const mcpToken = Buffer.alloc(32, 76).toString('base64url');

const result: RecurringSeriesResult = {
  freshness: {
    isStale: false,
    lastSuccessfulSyncAt: new Date('2026-08-27T00:00:00Z'),
    oldestAccountSyncAt: new Date('2026-08-27T00:00:00Z'),
    staleAfterMinutes: 1440,
  },
  monthlyBaseline: [{ currency: 'BRL', value: '100.000001' }],
  policyVersion: 1,
  series: [
    {
      amountAverage: '100.000001',
      amountMax: '101.000001',
      amountMin: '99.000001',
      cadence: 'MONTHLY',
      confidence: '0.9500',
      currency: 'BRL',
      expectedIntervalDays: 30,
      id: seriesId,
      lastOccurrenceDate: '2026-08-01',
      merchantLabel: 'Synthetic Subscription',
      nextExpectedDate: '2026-08-31',
      observationCount: 3,
      priceChangePercent: '1.000000',
      status: 'CANDIDATE',
    },
  ],
  warnings: [{ assumption: 'CADENCE_NORMALIZED_MONTHLY', code: 'ESTIMATED_RECURRING_BASELINE' }],
};

function repository(): RecurringRouteRepository {
  return {
    detect: vi.fn(async () => ({ candidateCount: 1 })),
    list: vi.fn(async () => result),
    resolve: vi.fn(async () => undefined),
  };
}

function dependencies(repo = repository()): RecurringRouteDependencies {
  return {
    mcpToken,
    now: () => new Date('2026-08-27T00:30:00Z'),
    repository: repo,
    requestId: () => requestId,
    webToken,
    workspaceId,
  };
}

function request(path: string, token: string, method = 'GET', body?: unknown) {
  return {
    authorizationHeader: `Bearer ${token}`,
    body,
    method,
    url: new URL(path, 'http://cashcount.invalid'),
  };
}

describe('recurring route', () => {
  it('returns identifier-free analytics to web and MCP', async () => {
    for (const token of [webToken, mcpToken]) {
      const response = await processRecurringRequest(
        request('/v1/analytics/recurring-expenses', token),
        dependencies(),
      );
      expect(response?.status).toBe(200);
      expect(response?.body).toMatchObject({
        data: {
          monthlyBaseline: [{ amount: { value: '100.000001' } }],
          series: [{ cadence: 'MONTHLY', status: 'CANDIDATE' }],
        },
        meta: { policyVersion: 1, workspaceId },
      });
      expect(JSON.stringify(response?.body)).not.toContain(seriesId);
    }
  });

  it('keeps detection and audited review commands web-only', async () => {
    const repo = repository();
    expect(
      (
        await processRecurringRequest(
          request('/v1/recurring-expenses/detect', webToken, 'POST', {
            actorId: 'synthetic-owner',
          }),
          dependencies(repo),
        )
      )?.status,
    ).toBe(200);
    for (const [suffix, status] of [
      ['confirm', 'CONFIRMED'],
      ['reject', 'REJECTED'],
    ] as const) {
      expect(
        (
          await processRecurringRequest(
            request(`/v1/recurring-series/${seriesId}/${suffix}`, webToken, 'POST', {
              actorId: 'synthetic-owner',
            }),
            dependencies(repo),
          )
        )?.status,
      ).toBe(200);
      expect(repo.resolve).toHaveBeenCalledWith(workspaceId, seriesId, 'synthetic-owner', status);
      expect(
        (
          await processRecurringRequest(
            request(`/v1/recurring-series/${seriesId}/${suffix}`, mcpToken, 'POST', {
              actorId: 'synthetic-owner',
            }),
            dependencies(),
          )
        )?.status,
      ).toBe(401);
    }
  });

  it('exposes IDs only on the web review list and rejects invalid input', async () => {
    const review = await processRecurringRequest(
      request('/v1/recurring-series', webToken),
      dependencies(),
    );
    expect(JSON.stringify(review?.body)).toContain(seriesId);
    expect(
      (await processRecurringRequest(request('/v1/recurring-series', mcpToken), dependencies()))
        ?.status,
    ).toBe(401);
    expect(
      (
        await processRecurringRequest(
          request('/v1/recurring-expenses/detect', webToken, 'POST', {}),
          dependencies(),
        )
      )?.status,
    ).toBe(400);
  });
});
