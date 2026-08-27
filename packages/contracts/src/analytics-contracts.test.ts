import { describe, expect, it } from 'vitest';

import {
  analyticsFreshnessSchema,
  periodComparisonDataSchema,
  spendingCashFlowDataSchema,
  spendingCashFlowWarningSchema,
} from './analytics-contracts.js';

describe('analytics contracts', () => {
  it('keeps spending and cash flow separate with exact decimal strings', () => {
    expect(
      spendingCashFlowDataSchema.parse({
        categoryBreakdown: [],
        from: '2026-08-01',
        granularity: 'MONTH',
        includePending: false,
        merchantBreakdown: [],
        timeSeries: [],
        to: '2026-08-31',
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
            status: 'POSTED',
          },
        ],
      }),
    ).toBeDefined();
  });

  it('requires structured warnings and freshness', () => {
    expect(
      spendingCashFlowWarningSchema.parse({
        code: 'UNCONVERTED_CURRENCY',
        excludedTransactionCount: 2,
      }),
    ).toBeDefined();
    expect(
      analyticsFreshnessSchema.parse({
        isStale: false,
        lastSuccessfulSyncAt: '2026-08-27T00:00:00.000Z',
        oldestAccountSyncAt: '2026-08-26T23:00:00.000Z',
        staleAfterMinutes: 1440,
      }),
    ).toBeDefined();
  });

  it('represents period deltas exactly and leaves zero-denominator percentages null', () => {
    expect(
      periodComparisonDataSchema.parse({
        categoryChanges: [],
        comparisonFrom: '2026-07-01',
        comparisonTo: '2026-07-31',
        currentFrom: '2026-08-01',
        currentTo: '2026-08-31',
        includePending: false,
        mode: 'PREVIOUS_MONTH',
        sameElapsedDays: false,
        totals: [
          {
            absoluteDifference: '10.000001',
            comparisonTotal: '0.000000',
            currency: 'BRL',
            currentTotal: '10.000001',
            percentageDifference: null,
            status: 'POSTED',
          },
        ],
      }),
    ).toBeDefined();
  });

  it('rejects floating-point money and mixed envelope fields', () => {
    expect(() =>
      spendingCashFlowDataSchema.parse({
        categoryBreakdown: [],
        from: '2026-08-01',
        granularity: 'MONTH',
        includePending: false,
        merchantBreakdown: [],
        timeSeries: [],
        to: '2026-08-31',
        totals: [
          {
            cashFlow: {
              inflowTotal: 0.1,
              netCashFlow: '0',
              outflowTotal: '0',
              transactionCount: 0,
            },
            currency: 'BRL',
            spending: {
              grossSpending: '0',
              netSpending: '0',
              refundTotal: '0',
              transactionCount: 0,
            },
            status: 'POSTED',
          },
        ],
      }),
    ).toThrow();
  });
});
