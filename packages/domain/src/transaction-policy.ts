import {
  createSignedAmountEvidence,
  Money,
  type CurrencyCode,
  type SignedAmountEvidence,
} from './money.js';

export const accountTypes = ['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'INVESTMENT', 'OTHER'] as const;

export const transactionDirections = ['INFLOW', 'OUTFLOW', 'NEUTRAL', 'UNKNOWN'] as const;

export const transactionFinancialRoles = [
  'PURCHASE',
  'INCOME',
  'TRANSFER',
  'CARD_BILL_PAYMENT',
  'REFUND',
  'FEE',
  'TAX',
  'CASH_WITHDRAWAL',
  'ADJUSTMENT',
  'INVESTMENT_MOVEMENT',
  'CREDIT',
  'UNKNOWN_CREDIT',
  'UNKNOWN',
] as const;

export type AccountType = (typeof accountTypes)[number];
export type EconomicRepresentation =
  'BILL_FINANCE_CHARGE_EVIDENCE' | 'BILL_PAYMENT_EVIDENCE' | 'FINANCIAL_TRANSACTION';
export type FinancialRole = (typeof transactionFinancialRoles)[number];
export type ProviderDebitCreditType = 'CREDIT' | 'DEBIT' | null;
export type TransactionDirection = (typeof transactionDirections)[number];
export type TransactionPolicyWarning =
  | 'BILL_EVIDENCE_NOT_COUNTED'
  | 'UNCONVERTED_CURRENCY'
  | 'UNRESOLVED_CARD_CREDIT'
  | 'UNRESOLVED_FINANCE_CHARGE';

export interface TransactionClassificationEvidence {
  accountType: AccountType;
  financeChargeTransaction?: boolean;
  incomeEvidence?: boolean;
  internalTransferEvidence?: boolean;
  paymentEvidence?: 'BANK_SIDE_CONFIRMED' | 'CARD_SIDE_CONFIRMED' | 'NONE';
  providerAmountSigned: string;
  providerType: ProviderDebitCreditType;
  refundEvidence?: boolean;
  taxEvidence?: boolean;
  withdrawalEvidence?: boolean;
}

export interface TransactionClassification {
  direction: TransactionDirection;
  role: FinancialRole;
}

export interface TransactionEffectInput {
  accountType: AccountType;
  amounts: SignedAmountEvidence;
  direction: TransactionDirection;
  excludedFromSpend?: boolean;
  financeChargeMatchedTransaction?: boolean;
  internalTransfer?: boolean;
  representation?: EconomicRepresentation;
  role: FinancialRole;
}

export interface TransactionEffects {
  analyticsAmount: Money | null;
  analyticsCurrency: CurrencyCode;
  cashflowEffect: Money | null;
  spendingEffect: Money | null;
  warnings: readonly TransactionPolicyWarning[];
}

function deriveDepositDirection(providerType: ProviderDebitCreditType): TransactionDirection {
  if (providerType === 'DEBIT') {
    return 'OUTFLOW';
  }

  if (providerType === 'CREDIT') {
    return 'INFLOW';
  }

  return 'UNKNOWN';
}

function deriveCardDirection(amount: Money): TransactionDirection {
  if (amount.isZero()) {
    return 'NEUTRAL';
  }

  return amount.isNegative() ? 'INFLOW' : 'OUTFLOW';
}

export function classifyTransaction(
  evidence: TransactionClassificationEvidence,
): TransactionClassification {
  const amount = Money.from(evidence.providerAmountSigned, 'XXX');
  const direction =
    evidence.accountType === 'CREDIT_CARD'
      ? deriveCardDirection(amount)
      : evidence.accountType === 'CHECKING' || evidence.accountType === 'SAVINGS'
        ? deriveDepositDirection(evidence.providerType)
        : 'UNKNOWN';
  const paymentEvidence = evidence.paymentEvidence ?? 'NONE';

  if (paymentEvidence !== 'NONE') {
    return { direction, role: 'CARD_BILL_PAYMENT' };
  }

  if (evidence.internalTransferEvidence === true) {
    return { direction, role: 'TRANSFER' };
  }

  if (evidence.financeChargeTransaction === true) {
    return { direction, role: 'FEE' };
  }

  if (evidence.taxEvidence === true) {
    return { direction, role: 'TAX' };
  }

  if (evidence.refundEvidence === true) {
    return { direction, role: 'REFUND' };
  }

  if (evidence.withdrawalEvidence === true && direction === 'OUTFLOW') {
    return { direction, role: 'CASH_WITHDRAWAL' };
  }

  if (evidence.accountType === 'CREDIT_CARD') {
    if (amount.isNegative()) {
      return { direction, role: 'UNKNOWN_CREDIT' };
    }

    return { direction, role: amount.isZero() ? 'UNKNOWN' : 'PURCHASE' };
  }

  if (evidence.accountType === 'CHECKING' || evidence.accountType === 'SAVINGS') {
    if (direction === 'OUTFLOW') {
      return { direction, role: 'PURCHASE' };
    }

    if (direction === 'INFLOW') {
      return { direction, role: evidence.incomeEvidence === true ? 'INCOME' : 'UNKNOWN_CREDIT' };
    }
  }

  return { direction, role: 'UNKNOWN' };
}

export function selectAnalyticsAmount(amounts: SignedAmountEvidence): Money | null {
  if (amounts.accountCurrencyAmountSigned !== null) {
    return Money.from(amounts.accountCurrencyAmountSigned, amounts.accountCurrency);
  }

  if (amounts.providerCurrency === amounts.accountCurrency) {
    return Money.from(amounts.providerAmountSigned, amounts.accountCurrency);
  }

  return null;
}

function spendingEffect(
  amount: Money | null,
  currency: CurrencyCode,
  role: FinancialRole,
  excludedFromSpend: boolean,
): Money | null {
  if (excludedFromSpend) {
    return Money.zero(currency);
  }

  if (role === 'PURCHASE' || role === 'FEE' || role === 'TAX') {
    return amount?.abs() ?? null;
  }

  if (role === 'REFUND' || role === 'CREDIT') {
    return amount?.abs().negate() ?? null;
  }

  return Money.zero(currency);
}

function cashflowEffect(
  amount: Money | null,
  accountType: AccountType,
  currency: CurrencyCode,
  direction: TransactionDirection,
  internalTransfer: boolean,
  role: FinancialRole,
): Money | null {
  if (
    (accountType !== 'CHECKING' && accountType !== 'SAVINGS') ||
    internalTransfer ||
    role === 'TRANSFER'
  ) {
    return Money.zero(currency);
  }

  if (direction === 'INFLOW') {
    return amount?.abs() ?? null;
  }

  if (direction === 'OUTFLOW') {
    return amount?.abs().negate() ?? null;
  }

  return Money.zero(currency);
}

export function calculateTransactionEffects(input: TransactionEffectInput): TransactionEffects {
  const representation = input.representation ?? 'FINANCIAL_TRANSACTION';
  const analyticsAmount = selectAnalyticsAmount(input.amounts);
  const warnings: TransactionPolicyWarning[] = [];

  if (analyticsAmount === null) {
    warnings.push('UNCONVERTED_CURRENCY');
  }

  if (input.role === 'UNKNOWN_CREDIT' && input.accountType === 'CREDIT_CARD') {
    warnings.push('UNRESOLVED_CARD_CREDIT');
  }

  if (representation === 'BILL_FINANCE_CHARGE_EVIDENCE') {
    if (input.financeChargeMatchedTransaction !== true) {
      warnings.push('UNRESOLVED_FINANCE_CHARGE');
    }
    warnings.push('BILL_EVIDENCE_NOT_COUNTED');

    return {
      analyticsAmount,
      analyticsCurrency: input.amounts.accountCurrency,
      cashflowEffect: Money.zero(input.amounts.accountCurrency),
      spendingEffect: Money.zero(input.amounts.accountCurrency),
      warnings,
    };
  }

  if (representation === 'BILL_PAYMENT_EVIDENCE') {
    warnings.push('BILL_EVIDENCE_NOT_COUNTED');

    return {
      analyticsAmount,
      analyticsCurrency: input.amounts.accountCurrency,
      cashflowEffect: Money.zero(input.amounts.accountCurrency),
      spendingEffect: Money.zero(input.amounts.accountCurrency),
      warnings,
    };
  }

  return {
    analyticsAmount,
    analyticsCurrency: input.amounts.accountCurrency,
    cashflowEffect: cashflowEffect(
      analyticsAmount,
      input.accountType,
      input.amounts.accountCurrency,
      input.direction,
      input.internalTransfer ?? false,
      input.role,
    ),
    spendingEffect: spendingEffect(
      analyticsAmount,
      input.amounts.accountCurrency,
      input.role,
      input.excludedFromSpend ?? false,
    ),
    warnings,
  };
}

export function transactionAmounts(input: {
  accountCurrency: string;
  accountCurrencyAmountSigned: string | null;
  providerAmountSigned: string;
  providerCurrency: string;
}): SignedAmountEvidence {
  return createSignedAmountEvidence(input);
}
