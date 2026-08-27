import { describe, expect, it } from 'vitest';

import { transactionPatchSchema, transactionSchema } from './transaction-contracts.js';

const transaction = {
  account: {
    accountType: 'CHECKING',
    id: '10000000-0000-4000-8000-000000000062',
    maskedNumber: '1234',
    name: 'Checking',
  },
  accountCurrencyAmount: { currency: 'BRL', value: '-10.100001' },
  analyticsAmount: { currency: 'BRL', value: '-10.100001' },
  bill: null,
  card: null,
  description: 'Synthetic purchase',
  duplicateReviewStatus: 'NONE',
  effective: {
    category: { override: { mode: 'CLEAR' }, source: 'USER', value: null },
    excludedFromSpend: { override: { mode: 'SET', value: false }, source: 'USER', value: false },
    financialRole: { override: { mode: 'INHERIT' }, source: 'HEURISTIC', value: 'PURCHASE' },
    merchant: { override: { mode: 'INHERIT' }, source: 'NONE', value: null },
  },
  freshness: {
    isStale: false,
    lastSuccessfulSyncAt: '2026-08-26T12:00:00.000Z',
    requiresConnectionAttention: false,
  },
  id: '20000000-0000-4000-8000-000000000062',
  localDate: '2026-08-26',
  notes: 'Owner note',
  originalAmount: { currency: 'BRL', value: '-10.100001' },
  purchaseAt: null,
  purchaseLocalDate: null,
  replacementContext: [],
  reviewStatus: 'CONFIRMED',
  status: 'POSTED',
  tags: [],
  transactionAt: '2026-08-26T12:00:00.000Z',
  userStateVersion: 1,
  warnings: [],
} as const;

describe('transaction API contracts', () => {
  it('preserves signed decimal strings and strict effective provenance', () => {
    expect(transactionSchema.parse(transaction)).toEqual(transaction);
    expect(() =>
      transactionSchema.parse({ ...transaction, originalAmount: { currency: 'BRL', value: 10.1 } }),
    ).toThrow();
    expect(() =>
      transactionSchema.parse({ ...transaction, providerTransactionId: 'private' }),
    ).toThrow();
  });

  it('accepts only explicit user-owned override operations', () => {
    expect(
      transactionPatchSchema.parse({
        categoryOverride: { mode: 'CLEAR' },
        expectedVersion: 1,
        financialRoleOverride: { mode: 'SET', value: 'PURCHASE' },
        tagIds: ['30000000-0000-4000-8000-000000000062'],
      }),
    ).toBeDefined();
    expect(() => transactionPatchSchema.parse({ expectedVersion: 1 })).toThrow();
    expect(() =>
      transactionPatchSchema.parse({ expectedVersion: 1, providerAmountSigned: '1.00' }),
    ).toThrow();
  });

  it('rejects duplicate tags and invalid nullable-override shapes', () => {
    const tagId = '30000000-0000-4000-8000-000000000062';
    expect(() =>
      transactionPatchSchema.parse({ expectedVersion: 0, notes: null, tagIds: [tagId, tagId] }),
    ).toThrow(/unique/u);
    expect(() =>
      transactionPatchSchema.parse({ categoryOverride: { mode: 'SET' }, expectedVersion: 0 }),
    ).toThrow();
  });
});
