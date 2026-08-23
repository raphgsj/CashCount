import { describe, expect, it } from 'vitest';

import {
  pluggyAccountBody,
  pluggyBillsBody,
  pluggyHistoryPages,
  pluggyItemLifecycleFixtures,
  pluggyReplacementFixture,
  pluggyTransactionMatrixBody,
  pluggyTransactionMatrixExpected,
} from './pluggy.js';

describe('sanitized Pluggy fixture matrix', () => {
  it('covers every provider-contract edge required by PF-025', () => {
    expect(
      new Set(pluggyItemLifecycleFixtures.map((fixture) => fixture.expectedLocalStatus)),
    ).toEqual(
      new Set([
        'ACTIVE',
        'SYNCING',
        'USER_INPUT_REQUIRED',
        'USER_ACTION_REQUIRED',
        'REAUTH_REQUIRED',
        'PROVIDER_ERROR',
      ]),
    );
    expect(pluggyTransactionMatrixExpected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amountSigned: '89.9', currency: 'BRL' }),
        expect.objectContaining({ amountSigned: '-20.1' }),
        expect.objectContaining({
          amountInAccountCurrencySigned: '67.890123',
          currency: 'USD',
        }),
        expect.objectContaining({ amountInAccountCurrencySigned: null, currency: 'EUR' }),
      ]),
    );
    expect(pluggyHistoryPages.map((page) => page.expectedCoverage)).toEqual([
      'PARTIAL',
      'PROVIDER_MAXIMUM_RETRIEVED',
    ]);
    expect(pluggyBillsBody).toContain('"payments"');
    expect(pluggyBillsBody).toContain('"financeCharges"');
    expect(pluggyReplacementFixture.predecessorBody).not.toBe(
      pluggyReplacementFixture.successorBody,
    );
  });

  it('contains only synthetic, masked, credential-free evidence', () => {
    const fixtureText = [
      pluggyAccountBody,
      pluggyBillsBody,
      pluggyTransactionMatrixBody,
      ...pluggyHistoryPages.map((fixture) => fixture.responseBody),
      ...pluggyItemLifecycleFixtures.map((fixture) => fixture.responseBody),
      ...Object.values(pluggyReplacementFixture).map((value) =>
        typeof value === 'string' ? value : JSON.stringify(value),
      ),
    ].join('\n');

    expect(fixtureText).toContain('Synthetic');
    expect(fixtureText).not.toMatch(
      /"(?:clientSecret|accessToken|api[_-]?key|authorization|cpf|cnpj|taxNumber)"\s*:/iu,
    );
    expect(JSON.parse(pluggyAccountBody)).toMatchObject({ number: '0042' });
    const transactionMatrix = JSON.parse(pluggyTransactionMatrixBody) as {
      results: { creditCardMetadata: null | { cardNumber: string } }[];
    };
    expect(transactionMatrix.results[2]?.creditCardMetadata).toMatchObject({ cardNumber: '0099' });
    expect(fixtureText).not.toContain('411111111111');
  });
});
