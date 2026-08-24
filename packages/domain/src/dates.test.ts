import { describe, expect, it } from 'vitest';

import {
  addBankDays,
  billForecastMonthFromBankDate,
  billForecastMonthToBankDate,
  deriveFinancialDate,
  InvalidBankDateError,
  InvalidBillForecastMonthError,
  InvalidInstantError,
  InvalidTimezoneError,
  parseBankDate,
  parseBillForecastMonth,
  parseIanaTimezone,
  parseInstant,
} from './dates.js';

describe('financial dates', () => {
  it('validates calendar bank dates without local-time parsing', () => {
    expect(parseBankDate('2024-02-29')).toBe('2024-02-29');
    expect(addBankDays(parseBankDate('2024-02-28'), 2)).toBe('2024-03-01');
    expect(() => parseBankDate('2026-02-29')).toThrow(InvalidBankDateError);
    expect(() => parseBankDate('23/08/2026')).toThrow(InvalidBankDateError);
  });

  it('keeps month-only bill forecasts distinct from arbitrary dates', () => {
    const month = parseBillForecastMonth('2026-08');

    expect(billForecastMonthToBankDate(month)).toBe('2026-08-01');
    expect(billForecastMonthFromBankDate(parseBankDate('2026-08-01'))).toBe('2026-08');
    expect(() => parseBillForecastMonth('2026-13')).toThrow(InvalidBillForecastMonthError);
    expect(() => billForecastMonthFromBankDate(parseBankDate('2026-08-02'))).toThrow(
      InvalidBillForecastMonthError,
    );
  });

  it('derives local dates using arbitrary IANA timezones around midnight', () => {
    const instant = '2026-08-23T01:30:00.000Z';

    expect(deriveFinancialDate(instant, 'America/Sao_Paulo')).toBe('2026-08-22');
    expect(deriveFinancialDate(instant, 'Asia/Tokyo')).toBe('2026-08-23');
    expect(deriveFinancialDate('2026-03-08T04:30:00Z', 'America/New_York')).toBe('2026-03-07');
    expect(deriveFinancialDate('2026-03-08T07:30:00Z', 'America/New_York')).toBe('2026-03-08');
  });

  it.each([
    ['UTC midnight', '2026-08-24T00:00:00Z', '2026-08-23'],
    ['before local midnight', '2026-08-24T02:59:59Z', '2026-08-23'],
    ['at local midnight', '2026-08-24T03:00:00Z', '2026-08-24'],
    ['month boundary', '2026-09-01T02:59:59Z', '2026-08-31'],
    ['year boundary', '2027-01-01T02:59:59Z', '2026-12-31'],
    ['leap-day boundary', '2024-03-01T02:59:59Z', '2024-02-29'],
    ['explicit offset', '2026-08-24T00:30:00-03:00', '2026-08-24'],
  ])('derives the Sao Paulo %s fixture', (_name, instant, expected) => {
    expect(deriveFinancialDate(instant, 'America/Sao_Paulo')).toBe(expected);
  });

  it('requires valid timezones and explicit-offset instants', () => {
    expect(parseIanaTimezone('Pacific/Auckland')).toBe('Pacific/Auckland');
    expect(parseInstant('2026-08-23T01:30:00-03:00').toISOString()).toBe(
      '2026-08-23T04:30:00.000Z',
    );
    expect(() => parseIanaTimezone('UTC-3')).toThrow(InvalidTimezoneError);
    expect(() => parseInstant('2026-08-23T01:30:00')).toThrow(InvalidInstantError);
  });
});
