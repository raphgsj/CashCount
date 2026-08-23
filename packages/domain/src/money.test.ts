import { describe, expect, it } from 'vitest';

import {
  createSignedAmountEvidence,
  InvalidCurrencyCodeError,
  InvalidDecimalStringError,
  Money,
  MoneyCurrencyMismatchError,
  parseDecimalString,
} from './money.js';

describe('money', () => {
  it('uses exact fixed-point decimal arithmetic and string-only JSON', () => {
    const total = Money.from('0.1', 'BRL').add(Money.from('0.2', 'BRL'));

    expect(total.toDecimalString()).toBe('0.3');
    expect(total.subtract(Money.from('0.05', 'BRL')).toDecimalString()).toBe('0.25');
    expect(Money.from('-12.340000', 'BRL').abs().toDecimalString()).toBe('12.34');
    expect(JSON.stringify(total)).toBe('{"amount":"0.3","currency":"BRL"}');
    expect(JSON.parse(JSON.stringify(total))).toEqual({ amount: '0.3', currency: 'BRL' });
  });

  it('never combines currencies implicitly', () => {
    expect(() => Money.from('1', 'BRL').add(Money.from('1', 'USD'))).toThrow(
      MoneyCurrencyMismatchError,
    );
    expect(Money.from('1', 'BRL').equals(Money.from('1', 'USD'))).toBe(false);
  });

  it('validates PostgreSQL numeric(20,6)-compatible decimal strings', () => {
    expect(parseDecimalString('-0.000000')).toBe('0');
    expect(parseDecimalString('99999999999999.999999')).toBe('99999999999999.999999');

    for (const invalid of [
      '',
      '+1',
      '01',
      '.1',
      '1.',
      '1e3',
      '0.0000001',
      '100000000000000.000000',
      'NaN',
      'Infinity',
    ]) {
      expect(() => parseDecimalString(invalid), invalid).toThrow(InvalidDecimalStringError);
    }
  });

  it('preserves signed provider and optional account-currency evidence independently', () => {
    expect(
      createSignedAmountEvidence({
        accountCurrency: 'BRL',
        accountCurrencyAmountSigned: null,
        providerAmountSigned: '-42.125000',
        providerCurrency: 'USD',
      }),
    ).toEqual({
      accountCurrency: 'BRL',
      accountCurrencyAmountSigned: null,
      providerAmountSigned: '-42.125',
      providerCurrency: 'USD',
    });
    expect(() => Money.from('1', 'brl')).toThrow(InvalidCurrencyCodeError);
  });
});
