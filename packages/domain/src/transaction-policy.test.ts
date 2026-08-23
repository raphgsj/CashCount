import { describe, expect, it } from 'vitest';

import {
  calculateTransactionEffects,
  classifyTransaction,
  transactionAmounts,
  type TransactionEffectInput,
} from './transaction-policy.js';

function amount(
  value: ReturnType<typeof calculateTransactionEffects>['spendingEffect'],
): string | null {
  return value?.toDecimalString() ?? null;
}

function effects(
  input: Omit<TransactionEffectInput, 'amounts'> & {
    accountCurrency?: string;
    accountCurrencyAmountSigned?: string | null;
    providerAmountSigned?: string;
    providerCurrency?: string;
  },
) {
  return calculateTransactionEffects({
    ...input,
    amounts: transactionAmounts({
      accountCurrency: input.accountCurrency ?? 'BRL',
      accountCurrencyAmountSigned: input.accountCurrencyAmountSigned ?? null,
      providerAmountSigned: input.providerAmountSigned ?? '-100.000000',
      providerCurrency: input.providerCurrency ?? 'BRL',
    }),
  });
}

describe('transaction policy', () => {
  it.each([
    {
      evidence: {
        accountType: 'CREDIT_CARD' as const,
        providerAmountSigned: '100',
        providerType: 'CREDIT' as const,
      },
      expected: { direction: 'OUTFLOW', role: 'PURCHASE' },
    },
    {
      evidence: {
        accountType: 'CREDIT_CARD' as const,
        providerAmountSigned: '-100',
        providerType: 'DEBIT' as const,
      },
      expected: { direction: 'INFLOW', role: 'UNKNOWN_CREDIT' },
    },
    {
      evidence: {
        accountType: 'CREDIT_CARD' as const,
        providerAmountSigned: '-100',
        providerType: null,
        refundEvidence: true,
      },
      expected: { direction: 'INFLOW', role: 'REFUND' },
    },
    {
      evidence: {
        accountType: 'CREDIT_CARD' as const,
        financeChargeTransaction: true,
        providerAmountSigned: '10',
        providerType: null,
      },
      expected: { direction: 'OUTFLOW', role: 'FEE' },
    },
    {
      evidence: {
        accountType: 'CHECKING' as const,
        providerAmountSigned: '-100',
        providerType: 'DEBIT' as const,
      },
      expected: { direction: 'OUTFLOW', role: 'PURCHASE' },
    },
    {
      evidence: {
        accountType: 'CHECKING' as const,
        incomeEvidence: true,
        providerAmountSigned: '100',
        providerType: 'CREDIT' as const,
      },
      expected: { direction: 'INFLOW', role: 'INCOME' },
    },
    {
      evidence: {
        accountType: 'CHECKING' as const,
        providerAmountSigned: '-100',
        providerType: null,
      },
      expected: { direction: 'UNKNOWN', role: 'UNKNOWN' },
    },
    {
      evidence: {
        accountType: 'CREDIT_CARD' as const,
        paymentEvidence: 'CARD_SIDE_CONFIRMED' as const,
        providerAmountSigned: '-100',
        providerType: null,
      },
      expected: { direction: 'INFLOW', role: 'CARD_BILL_PAYMENT' },
    },
    {
      evidence: {
        accountType: 'CHECKING' as const,
        paymentEvidence: 'BANK_SIDE_CONFIRMED' as const,
        providerAmountSigned: '-100',
        providerType: 'DEBIT' as const,
      },
      expected: { direction: 'OUTFLOW', role: 'CARD_BILL_PAYMENT' },
    },
  ])('classifies account-aware evidence %#', ({ evidence, expected }) => {
    expect(classifyTransaction(evidence)).toEqual(expected);
  });

  it.each([
    {
      input: {
        accountType: 'CREDIT_CARD' as const,
        direction: 'OUTFLOW' as const,
        role: 'PURCHASE' as const,
        providerAmountSigned: '100',
      },
      expectedCashflow: '0',
      expectedSpending: '100',
    },
    {
      input: {
        accountType: 'CREDIT_CARD' as const,
        direction: 'INFLOW' as const,
        role: 'REFUND' as const,
      },
      expectedCashflow: '0',
      expectedSpending: '-100',
    },
    {
      input: {
        accountType: 'CHECKING' as const,
        direction: 'OUTFLOW' as const,
        role: 'FEE' as const,
      },
      expectedCashflow: '-100',
      expectedSpending: '100',
    },
    {
      input: {
        accountType: 'CHECKING' as const,
        direction: 'OUTFLOW' as const,
        role: 'TAX' as const,
      },
      expectedCashflow: '-100',
      expectedSpending: '100',
    },
    {
      input: {
        accountType: 'CHECKING' as const,
        direction: 'INFLOW' as const,
        role: 'INCOME' as const,
        providerAmountSigned: '100',
      },
      expectedCashflow: '100',
      expectedSpending: '0',
    },
    {
      input: {
        accountType: 'CHECKING' as const,
        direction: 'OUTFLOW' as const,
        role: 'CARD_BILL_PAYMENT' as const,
      },
      expectedCashflow: '-100',
      expectedSpending: '0',
    },
    {
      input: {
        accountType: 'CREDIT_CARD' as const,
        direction: 'INFLOW' as const,
        role: 'CARD_BILL_PAYMENT' as const,
      },
      expectedCashflow: '0',
      expectedSpending: '0',
    },
    {
      input: {
        accountType: 'CHECKING' as const,
        direction: 'OUTFLOW' as const,
        internalTransfer: true,
        role: 'TRANSFER' as const,
      },
      expectedCashflow: '0',
      expectedSpending: '0',
    },
    {
      input: {
        accountType: 'CHECKING' as const,
        direction: 'OUTFLOW' as const,
        excludedFromSpend: true,
        role: 'PURCHASE' as const,
      },
      expectedCashflow: '-100',
      expectedSpending: '0',
    },
  ])(
    'calculates distinct spending and cash-flow effects %#',
    ({ input, expectedCashflow, expectedSpending }) => {
      const result = effects(input);

      expect(amount(result.spendingEffect)).toBe(expectedSpending);
      expect(amount(result.cashflowEffect)).toBe(expectedCashflow);
    },
  );

  it('counts bill children as evidence and a matched finance-charge transaction only once', () => {
    const paymentEvidence = effects({
      accountType: 'CREDIT_CARD',
      direction: 'NEUTRAL',
      representation: 'BILL_PAYMENT_EVIDENCE',
      role: 'CARD_BILL_PAYMENT',
      providerAmountSigned: '100',
    });
    const unmatchedCharge = effects({
      accountType: 'CREDIT_CARD',
      direction: 'NEUTRAL',
      representation: 'BILL_FINANCE_CHARGE_EVIDENCE',
      role: 'FEE',
      providerAmountSigned: '10',
    });
    const matchedChargeTransaction = effects({
      accountType: 'CREDIT_CARD',
      direction: 'OUTFLOW',
      role: 'FEE',
      providerAmountSigned: '10',
    });

    expect(amount(paymentEvidence.spendingEffect)).toBe('0');
    expect(paymentEvidence.warnings).toContain('BILL_EVIDENCE_NOT_COUNTED');
    expect(amount(unmatchedCharge.spendingEffect)).toBe('0');
    expect(unmatchedCharge.warnings).toEqual([
      'UNRESOLVED_FINANCE_CHARGE',
      'BILL_EVIDENCE_NOT_COUNTED',
    ]);
    expect(amount(matchedChargeTransaction.spendingEffect)).toBe('10');
  });

  it('omits incompatible amounts while retaining structured warnings', () => {
    const purchase = effects({
      accountCurrency: 'BRL',
      accountType: 'CHECKING',
      direction: 'OUTFLOW',
      providerAmountSigned: '-20',
      providerCurrency: 'USD',
      role: 'PURCHASE',
    });
    const unresolvedCardCredit = effects({
      accountCurrency: 'BRL',
      accountType: 'CREDIT_CARD',
      direction: 'INFLOW',
      providerAmountSigned: '-20',
      providerCurrency: 'USD',
      role: 'UNKNOWN_CREDIT',
    });

    expect(purchase.analyticsAmount).toBeNull();
    expect(purchase.spendingEffect).toBeNull();
    expect(purchase.cashflowEffect).toBeNull();
    expect(purchase.warnings).toEqual(['UNCONVERTED_CURRENCY']);
    expect(amount(unresolvedCardCredit.spendingEffect)).toBe('0');
    expect(amount(unresolvedCardCredit.cashflowEffect)).toBe('0');
    expect(unresolvedCardCredit.warnings).toEqual([
      'UNCONVERTED_CURRENCY',
      'UNRESOLVED_CARD_CREDIT',
    ]);
  });

  it('prefers supplied account-currency amounts without fabricating conversion', () => {
    const converted = effects({
      accountCurrency: 'BRL',
      accountCurrencyAmountSigned: '-550.250000',
      accountType: 'CHECKING',
      direction: 'OUTFLOW',
      providerAmountSigned: '-100',
      providerCurrency: 'USD',
      role: 'PURCHASE',
    });

    expect(amount(converted.analyticsAmount)).toBe('-550.25');
    expect(amount(converted.spendingEffect)).toBe('550.25');
    expect(amount(converted.cashflowEffect)).toBe('-550.25');
    expect(converted.warnings).toEqual([]);
  });
});
