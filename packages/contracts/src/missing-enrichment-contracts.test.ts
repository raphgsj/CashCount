import { describe, expect, it } from 'vitest';

import {
  mcpUnclassifiedSummarySchema,
  webUnclassifiedTransactionSchema,
} from './missing-enrichment-contracts.js';

describe('missing-enrichment consumer contracts', () => {
  it('represents absent UI category and merchant as unclassified data', () => {
    expect(
      webUnclassifiedTransactionSchema.parse({
        amount: { currency: 'BRL', hasUnconvertedCurrency: false, value: '-20.100000' },
        category: null,
        classificationState: 'UNCLASSIFIED',
        description: {
          normalized: 'synthetic unresolved credit',
          original: 'Synthetic unresolved credit',
        },
        id: '70000000-0000-4000-8000-000000000057',
        merchant: null,
        providerCategoryName: null,
        transactionDate: '2026-08-21',
        warnings: ['MISSING_CATEGORY', 'MISSING_MERCHANT'],
      }),
    ).toMatchObject({ category: null, classificationState: 'UNCLASSIFIED', merchant: null });
  });

  it('keeps the MCP summary bounded, nullable, exact, and free of identifiers', () => {
    const input = {
      asOf: '2026-08-24T12:00:00.000Z',
      currency: 'BRL',
      freshnessWarning: null,
      policyVersion: 'classification-quality-v1',
      requestedPeriod: { from: '2026-08-01', to: '2026-08-31' },
      sample: [
        {
          amountSigned: null,
          category: null,
          financialRole: 'UNKNOWN',
          merchant: null,
          transactionDate: '2026-08-22',
          warnings: ['MISSING_CATEGORY', 'MISSING_MERCHANT', 'UNCONVERTED_CURRENCY'],
        },
      ],
      unclassifiedCount: 3,
    };
    expect(mcpUnclassifiedSummarySchema.parse(input)).toEqual(input);
    expect(
      mcpUnclassifiedSummarySchema.safeParse({
        ...input,
        providerTransactionId: 'must-not-cross-the-contract',
      }).success,
    ).toBe(false);
    expect(
      mcpUnclassifiedSummarySchema.safeParse({
        ...input,
        sample: Array.from({ length: 21 }, () => input.sample[0]),
      }).success,
    ).toBe(false);
  });
});
