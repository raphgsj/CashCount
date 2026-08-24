import { describe, expect, it } from 'vitest';

import {
  scoreTransactionReplacement,
  transactionReplacementAutoConfirmThreshold,
  type ReplacementTransactionFacts,
} from './replacement-policy.js';

function facts(overrides: Partial<ReplacementTransactionFacts> = {}): ReplacementTransactionFacts {
  return {
    accountId: 'account-1',
    amountSigned: '42.420000',
    billForecastMonth: null,
    cardLastFour: null,
    currency: 'BRL',
    descriptionNormalized: 'synthetic replacement candidate',
    installmentNumber: null,
    installmentTotal: null,
    localDate: '2026-08-23',
    payeeMcc: null,
    providerBillId: null,
    providerType: 'DEBIT',
    ...overrides,
  };
}

describe('transaction replacement policy', () => {
  it('scores exact candidates above the auto-confirm threshold without optional enrichment', () => {
    const score = scoreTransactionReplacement(facts(), facts());

    expect(score).toMatchObject({ eligible: true, incompatibleFeature: null, score: '1.0000' });
    expect(score.score >= transactionReplacementAutoConfirmThreshold).toBe(true);
  });

  it.each([
    ['account', { accountId: 'account-2' }],
    ['currency', { currency: 'USD' }],
    ['amount', { amountSigned: '42.430000' }],
    ['date', { localDate: '2026-08-27' }],
    ['cardLastFour', { cardLastFour: '1234' }],
  ] as const)('rejects a hard %s conflict', (feature, overrides) => {
    const predecessor = facts(feature === 'cardLastFour' ? { cardLastFour: '4321' } : {});
    expect(scoreTransactionReplacement(predecessor, facts(overrides))).toMatchObject({
      eligible: false,
      incompatibleFeature: feature,
    });
  });

  it('keeps weak descriptions reviewable instead of treating fingerprints as identity', () => {
    expect(
      scoreTransactionReplacement(
        facts(),
        facts({ descriptionNormalized: 'different provider correction' }),
      ),
    ).toMatchObject({ eligible: true, score: '0.7500' });
  });
});
