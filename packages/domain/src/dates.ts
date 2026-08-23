const bankDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const billForecastMonthPattern = /^(\d{4})-(\d{2})$/u;
const explicitInstantZonePattern = /T.*(?:Z|[+-]\d{2}:\d{2})$/u;

declare const bankDateBrand: unique symbol;
declare const billForecastMonthBrand: unique symbol;
declare const ianaTimezoneBrand: unique symbol;

export type BankDate = string & { readonly [bankDateBrand]: true };
export type BillForecastMonth = string & { readonly [billForecastMonthBrand]: true };
export type IanaTimezone = string & { readonly [ianaTimezoneBrand]: true };

export class InvalidBankDateError extends Error {
  public constructor(value: string) {
    super(`Invalid bank date: ${value}.`);
    this.name = 'InvalidBankDateError';
  }
}

export class InvalidBillForecastMonthError extends Error {
  public constructor(value: string) {
    super(`Invalid bill forecast month: ${value}.`);
    this.name = 'InvalidBillForecastMonthError';
  }
}

export class InvalidInstantError extends Error {
  public constructor(value: string) {
    super(`Invalid explicit-offset instant: ${value}.`);
    this.name = 'InvalidInstantError';
  }
}

export class InvalidTimezoneError extends Error {
  public constructor(value: string) {
    super(`Invalid IANA timezone: ${value}.`);
    this.name = 'InvalidTimezoneError';
  }
}

function isValidUtcDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

export function parseBankDate(value: string): BankDate {
  const match = bankDatePattern.exec(value);
  if (match === null) {
    throw new InvalidBankDateError(value);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidUtcDate(year, month, day)) {
    throw new InvalidBankDateError(value);
  }

  return value as BankDate;
}

export function addBankDays(value: BankDate, days: number): BankDate {
  if (!Number.isSafeInteger(days)) {
    throw new RangeError('Bank-date day offsets must be safe integers.');
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);

  return parseBankDate(date.toISOString().slice(0, 10));
}

export function parseBillForecastMonth(value: string): BillForecastMonth {
  const match = billForecastMonthPattern.exec(value);
  if (match === null) {
    throw new InvalidBillForecastMonthError(value);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isInteger(year) || month < 1 || month > 12) {
    throw new InvalidBillForecastMonthError(value);
  }

  return value as BillForecastMonth;
}

export function billForecastMonthToBankDate(value: BillForecastMonth): BankDate {
  return parseBankDate(`${value}-01`);
}

export function billForecastMonthFromBankDate(value: BankDate): BillForecastMonth {
  if (!value.endsWith('-01')) {
    throw new InvalidBillForecastMonthError(value);
  }

  return parseBillForecastMonth(value.slice(0, 7));
}

export function parseIanaTimezone(value: string): IanaTimezone {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  } catch {
    throw new InvalidTimezoneError(value);
  }

  return value as IanaTimezone;
}

export function parseInstant(value: string): Date {
  if (!explicitInstantZonePattern.test(value)) {
    throw new InvalidInstantError(value);
  }

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    throw new InvalidInstantError(value);
  }

  return instant;
}

export function deriveFinancialDate(
  instant: Date | string,
  timezone: IanaTimezone | string,
): BankDate {
  const parsedTimezone = parseIanaTimezone(timezone);
  const parsedInstant = typeof instant === 'string' ? parseInstant(instant) : instant;
  if (Number.isNaN(parsedInstant.getTime())) {
    throw new InvalidInstantError(String(instant));
  }

  const parts = new Intl.DateTimeFormat('en-CA-u-ca-iso8601-nu-latn', {
    day: '2-digit',
    month: '2-digit',
    timeZone: parsedTimezone,
    year: 'numeric',
  }).formatToParts(parsedInstant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  return parseBankDate(`${part('year')}-${part('month')}-${part('day')}`);
}
