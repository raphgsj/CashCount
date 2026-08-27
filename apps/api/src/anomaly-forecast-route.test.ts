import { Buffer } from 'node:buffer';

import type { AnomalyCandidatesResult, MonthForecastResult } from '@cashcount/analytics';
import { describe, expect, it, vi } from 'vitest';

import {
  processAnomalyForecastRequest,
  type AnomalyForecastRouteDependencies,
  type AnomalyForecastRouteRepository,
} from './anomaly-forecast-route.js';

const workspaceId = '10000000-0000-4000-8000-000000000069';
const requestId = '30000000-0000-4000-8000-000000000069';
const webToken = Buffer.alloc(32, 79).toString('base64url');
const mcpToken = Buffer.alloc(32, 80).toString('base64url');
const now = new Date('2026-08-27T12:00:00Z');
const freshness = {
  isStale: false,
  lastSuccessfulSyncAt: new Date('2026-08-27T11:00:00Z'),
  oldestAccountSyncAt: new Date('2026-08-27T10:00:00Z'),
  staleAfterMinutes: 1440 as const,
};

function repository(): AnomalyForecastRouteRepository {
  return {
    anomalies: vi.fn(async (): Promise<AnomalyCandidatesResult> => ({
      asOf: '2026-08-27' as AnomalyCandidatesResult['asOf'],
      candidates: [
        {
          baselineValue: '100.000000',
          categoryLabel: null,
          currency: 'BRL',
          deviationPercent: '100.000000',
          merchantLabel: 'Synthetic Store',
          observedOn: '2026-08-27' as AnomalyCandidatesResult['asOf'],
          observedValue: '200.000000',
          rule: 'MERCHANT_AMOUNT_SPIKE',
          status: 'CANDIDATE',
          thresholdValue: '150.000000',
        },
      ],
      freshness,
      policyVersion: 1,
      warnings: [
        {
          categoryDeviationPercent: '50',
          code: 'ESTIMATED_ANOMALIES',
          duplicateWindowDays: 2,
          merchantDeviationPercent: '50',
          recurringIncreasePercent: '10',
        },
      ],
    })),
    forecast: vi.fn(async (): Promise<MonthForecastResult> => ({
      asOf: '2026-08-27' as MonthForecastResult['asOf'],
      currencies: [
        {
          actualMonthToDate: '270.000000',
          commitmentFloorForecast: '390.000000',
          confirmedInstallmentsRemaining: '20.000000',
          confirmedRecurringRemaining: '100.000000',
          currency: 'BRL',
          elapsedDays: 27,
          forecastTotal: '390.000000',
          knownCommitmentsRemaining: '120.000000',
          remainingDays: 4,
          runRateForecast: '310.000000',
          runRateRemaining: '40.000000',
          trailingThreeMonthAverage: '300.000000',
        },
      ],
      freshness,
      monthEnd: '2026-08-31' as MonthForecastResult['monthEnd'],
      monthStart: '2026-08-01' as MonthForecastResult['monthStart'],
      policyVersion: 1,
      warnings: [
        {
          assumptions: [
            'CURRENT_MONTH_NET_SPENDING_RUN_RATE',
            'CONFIRMED_RECURRING_NEXT_DATES',
            'CONFIRMED_INSTALLMENTS_MONTHLY_FROM_PURCHASE_DATE',
          ],
          code: 'ESTIMATED_FORECAST',
        },
        { code: 'COMMITMENTS_NOT_ADDITIVE', method: 'MAX_RUN_RATE_OR_COMMITMENT_FLOOR' },
      ],
    })),
  };
}

function dependencies(repo = repository()): AnomalyForecastRouteDependencies {
  return {
    mcpToken,
    now: () => now,
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

describe('anomaly and forecast routes', () => {
  it('returns bounded, explicitly estimated anomaly candidates to web and MCP readers', async () => {
    for (const token of [webToken, mcpToken]) {
      const result = await processAnomalyForecastRequest(
        request('/v1/analytics/anomaly-candidates', token),
        dependencies(),
      );
      expect(result?.status).toBe(200);
      expect(result?.body).toMatchObject({
        data: {
          candidates: [
            {
              baselineAmount: { currency: 'BRL', value: '100.000000' },
              observedAmount: { value: '200.000000' },
              rule: 'MERCHANT_AMOUNT_SPIKE',
              status: 'CANDIDATE',
            },
          ],
        },
        meta: { policyVersion: 1, workspaceId },
        warnings: [{ code: 'ESTIMATED_ANOMALIES' }],
      });
      expect(JSON.stringify(result?.body)).not.toMatch(/fraud/iu);
    }
  });

  it('returns an explainable currency-separated forecast without adding commitments twice', async () => {
    const repo = repository();
    const result = await processAnomalyForecastRequest(
      request('/v1/analytics/month-forecast', mcpToken),
      dependencies(repo),
    );
    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({
      data: {
        currencies: [
          {
            commitmentFloorForecast: { value: '390.000000' },
            forecastTotal: { value: '390.000000' },
            runRateForecast: { value: '310.000000' },
          },
        ],
      },
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'ESTIMATED_FORECAST' }),
        expect.objectContaining({ code: 'COMMITMENTS_NOT_ADDITIVE' }),
      ]),
    });
    expect(repo.forecast).toHaveBeenCalledWith(workspaceId, now);
  });

  it('rejects role substitution, mutation, caller scope, bodies, and unrelated paths', async () => {
    for (const input of [
      request('/v1/analytics/anomaly-candidates', 'wrong-token'),
      request('/v1/analytics/month-forecast', webToken, 'POST'),
      request('/v1/analytics/month-forecast?workspaceId=bad', webToken),
      request('/v1/analytics/month-forecast', webToken, 'GET', true),
    ]) {
      expect((await processAnomalyForecastRequest(input, dependencies()))?.status).not.toBe(200);
    }
    expect(
      await processAnomalyForecastRequest(request('/v1/unrelated', webToken), dependencies()),
    ).toBeNull();
  });
});
