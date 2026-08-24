import { describe, expect, it } from 'vitest';

import {
  detectBillPaymentRole,
  detectInternalTransfer,
  detectRefund,
  type FinancialRoleDetectionFacts,
} from './financial-role-detectors.js';

function facts(overrides: Partial<FinancialRoleDetectionFacts> = {}): FinancialRoleDetectionFacts {
  return {
    accountId: 'account-a',
    accountType: 'CHECKING',
    amountSigned: '-100.00',
    currency: 'BRL',
    descriptionNormalized: 'pix transferencia propria',
    direction: 'OUTFLOW',
    id: 'transaction-a',
    merchantId: null,
    transactionLocalDate: '2026-08-24',
    ...overrides,
  };
}

describe('conservative financial-role detectors', () => {
  it('requires normalized bill links for either side of a card payment', () => {
    expect(detectBillPaymentRole(facts({ accountType: 'CREDIT_CARD' }), {})).toMatchObject({
      role: null,
      status: 'NONE',
    });
    expect(
      detectBillPaymentRole(facts({ accountType: 'CREDIT_CARD' }), {
        matchedCardPaymentChildId: 'payment-child',
      }),
    ).toMatchObject({
      evidenceReference: 'payment-child',
      role: 'CARD_BILL_PAYMENT',
      status: 'CONFIRMED',
    });
    expect(
      detectBillPaymentRole(facts(), { activeBankReconciliationId: 'reconciliation' }),
    ).toMatchObject({
      evidenceReference: 'reconciliation',
      role: 'CARD_BILL_PAYMENT',
      status: 'CONFIRMED',
    });
    expect(
      detectBillPaymentRole(facts({ direction: 'INFLOW' }), {
        activeBankReconciliationId: 'reconciliation',
      }),
    ).toMatchObject({ role: null, status: 'NONE' });
  });

  it('auto-confirms one exact cross-account transfer with explicit evidence', () => {
    const counterpart = facts({
      accountId: 'account-b',
      amountSigned: '100.00',
      descriptionNormalized: 'pix recebido transferencia propria',
      direction: 'INFLOW',
      id: 'transaction-b',
      transactionLocalDate: '2026-08-25',
    });
    expect(detectInternalTransfer(facts(), [counterpart], '0.01')).toMatchObject({
      matchedTransactionId: 'transaction-b',
      status: 'AUTO_CONFIRMED',
    });
  });

  it('keeps competing transfers reviewable and rejects sign-only, currency, account, and date matches', () => {
    const match = facts({
      accountId: 'account-b',
      amountSigned: '100.00',
      direction: 'INFLOW',
      id: 'transaction-b',
    });
    expect(
      detectInternalTransfer(
        facts(),
        [match, { ...match, accountId: 'account-c', id: 'transaction-c' }],
        '0.01',
      ),
    ).toMatchObject({ matchedTransactionId: null, status: 'NEEDS_REVIEW' });
    expect(
      detectInternalTransfer(
        facts({ descriptionNormalized: 'ordinary purchase' }),
        [match],
        '0.01',
      ),
    ).toMatchObject({ status: 'NONE' });
    expect(detectInternalTransfer(facts(), [{ ...match, currency: 'USD' }], '0.01')).toMatchObject({
      status: 'NONE',
    });
    expect(
      detectInternalTransfer(facts(), [{ ...match, accountId: 'account-a' }], '0.01'),
    ).toMatchObject({ status: 'NONE' });
    expect(
      detectInternalTransfer(facts(), [{ ...match, transactionLocalDate: '2026-08-27' }], '0.01'),
    ).toMatchObject({ status: 'NONE' });
  });

  it('confirms a uniquely evidenced refund and keeps competing purchases reviewable', () => {
    const refund = facts({
      accountType: 'CREDIT_CARD',
      amountSigned: '-50.00',
      descriptionNormalized: 'estorno casa do pao',
      direction: 'INFLOW',
      id: 'refund',
      merchantId: 'merchant-a',
    });
    const purchase = facts({
      accountType: 'CREDIT_CARD',
      amountSigned: '50.00',
      descriptionNormalized: 'casa do pao',
      direction: 'OUTFLOW',
      id: 'purchase',
      merchantId: 'merchant-a',
      transactionLocalDate: '2026-08-20',
    });
    expect(detectRefund(refund, [purchase], '0.01')).toMatchObject({
      matchedTransactionId: 'purchase',
      status: 'AUTO_CONFIRMED',
    });
    expect(
      detectRefund(refund, [purchase, { ...purchase, id: 'purchase-2' }], '0.01'),
    ).toMatchObject({
      matchedTransactionId: null,
      status: 'NEEDS_REVIEW',
    });
  });

  it('does not infer refunds from negative card sign alone or incompatible evidence', () => {
    const purchase = facts({
      accountType: 'CREDIT_CARD',
      amountSigned: '50.00',
      descriptionNormalized: 'casa do pao',
      direction: 'OUTFLOW',
      id: 'purchase',
      merchantId: 'merchant-a',
      transactionLocalDate: '2026-08-20',
    });
    expect(
      detectRefund(
        facts({
          accountType: 'CREDIT_CARD',
          amountSigned: '-50.00',
          descriptionNormalized: 'casa do pao',
          direction: 'INFLOW',
        }),
        [purchase],
        '0.01',
      ),
    ).toMatchObject({ status: 'NONE' });
    expect(
      detectRefund(
        facts({
          accountType: 'CREDIT_CARD',
          amountSigned: '-50.00',
          descriptionNormalized: 'estorno unrelated',
          direction: 'INFLOW',
          merchantId: 'merchant-b',
        }),
        [purchase],
        '0.01',
      ),
    ).toMatchObject({ status: 'NONE' });
  });
});
