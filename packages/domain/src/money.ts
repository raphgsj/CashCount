import { Decimal } from 'decimal.js';

const FinancialDecimal = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -100,
  toExpPos: 100,
});

const decimalPattern = /^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/u;
const currencyPattern = /^[A-Z]{3}$/u;

declare const decimalStringBrand: unique symbol;
declare const currencyCodeBrand: unique symbol;

export type CurrencyCode = string & { readonly [currencyCodeBrand]: true };
export type DecimalString = string & { readonly [decimalStringBrand]: true };

export interface MoneyJson {
  amount: DecimalString;
  currency: CurrencyCode;
}

export interface SignedAmountEvidence {
  accountCurrency: CurrencyCode;
  accountCurrencyAmountSigned: DecimalString | null;
  providerAmountSigned: DecimalString;
  providerCurrency: CurrencyCode;
}

export class InvalidCurrencyCodeError extends Error {
  public constructor(value: string) {
    super(`Invalid ISO-style currency code: ${value}.`);
    this.name = 'InvalidCurrencyCodeError';
  }
}

export class InvalidDecimalStringError extends Error {
  public constructor(value: string) {
    super(`Invalid fixed-point decimal string: ${value}.`);
    this.name = 'InvalidDecimalStringError';
  }
}

export class MoneyCurrencyMismatchError extends Error {
  public constructor(left: CurrencyCode, right: CurrencyCode) {
    super(`Cannot combine ${left} and ${right} without an explicit conversion.`);
    this.name = 'MoneyCurrencyMismatchError';
  }
}

export function parseCurrencyCode(value: string): CurrencyCode {
  if (!currencyPattern.test(value)) {
    throw new InvalidCurrencyCodeError(value);
  }

  return value as CurrencyCode;
}

export function parseDecimalString(value: string): DecimalString {
  if (!decimalPattern.test(value)) {
    throw new InvalidDecimalStringError(value);
  }

  const decimal = new FinancialDecimal(value);
  if (!decimal.isFinite()) {
    throw new InvalidDecimalStringError(value);
  }

  return decimal.toFixed() as DecimalString;
}

export function createSignedAmountEvidence(input: {
  accountCurrency: string;
  accountCurrencyAmountSigned: string | null;
  providerAmountSigned: string;
  providerCurrency: string;
}): SignedAmountEvidence {
  return {
    accountCurrency: parseCurrencyCode(input.accountCurrency),
    accountCurrencyAmountSigned:
      input.accountCurrencyAmountSigned === null
        ? null
        : parseDecimalString(input.accountCurrencyAmountSigned),
    providerAmountSigned: parseDecimalString(input.providerAmountSigned),
    providerCurrency: parseCurrencyCode(input.providerCurrency),
  };
}

export class Money {
  readonly #amount: Decimal;

  public readonly currency: CurrencyCode;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    this.#amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  public static from(amount: string | DecimalString, currency: string | CurrencyCode): Money {
    const parsedAmount = parseDecimalString(amount);
    const parsedCurrency = parseCurrencyCode(currency);

    return new Money(new FinancialDecimal(parsedAmount), parsedCurrency);
  }

  public static zero(currency: string | CurrencyCode): Money {
    return Money.from('0', currency);
  }

  public abs(): Money {
    return new Money(this.#amount.abs(), this.currency);
  }

  public add(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#amount.add(other.#amount), this.currency);
  }

  public compare(other: Money): number {
    this.#assertSameCurrency(other);
    return this.#amount.comparedTo(other.#amount);
  }

  public equals(other: Money): boolean {
    return this.currency === other.currency && this.#amount.equals(other.#amount);
  }

  public isNegative(): boolean {
    return this.#amount.isNegative() && !this.#amount.isZero();
  }

  public isZero(): boolean {
    return this.#amount.isZero();
  }

  public negate(): Money {
    return new Money(this.#amount.negated(), this.currency);
  }

  public subtract(other: Money): Money {
    this.#assertSameCurrency(other);
    return new Money(this.#amount.minus(other.#amount), this.currency);
  }

  public toDecimalString(): DecimalString {
    return this.#amount.toFixed() as DecimalString;
  }

  public toJSON(): MoneyJson {
    return {
      amount: this.toDecimalString(),
      currency: this.currency,
    };
  }

  #assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new MoneyCurrencyMismatchError(this.currency, other.currency);
    }
  }
}
