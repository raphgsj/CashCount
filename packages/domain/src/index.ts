export const packageName = '@cashcount/domain' as const;

export {
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
  type BankDate,
  type BillForecastMonth,
  type IanaTimezone,
} from './dates.js';
export {
  createSignedAmountEvidence,
  InvalidCurrencyCodeError,
  InvalidDecimalStringError,
  Money,
  MoneyCurrencyMismatchError,
  parseCurrencyCode,
  parseDecimalString,
  type CurrencyCode,
  type DecimalString,
  type MoneyJson,
  type SignedAmountEvidence,
} from './money.js';
