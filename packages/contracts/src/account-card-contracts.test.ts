import { describe, expect, it } from 'vitest';

import {
  accountSummarySchema,
  cardBillFinanceChargeSchema,
  cardBillPaymentSchema,
  cardBillSummarySchema,
  cardSummarySchema,
} from './account-card-contracts.js';

const baseAccount = {
  accountSubtype: null,
  accountType: 'CHECKING',
  availableBalance: { currency: 'BRL', value: '900.123456' },
  currentBalance: { currency: 'BRL', value: '1000.123456' },
  historyCoverage: { earliestDate: '2026-01-01', latestDate: '2026-08-24', status: 'PARTIAL' },
  id: '10000000-0000-4000-8000-000000000061',
  institutionName: 'Synthetic Bank',
  isActive: true,
  lastSuccessfulSyncAt: '2026-08-24T12:00:00.000Z',
  maskedNumber: '1234',
  name: 'Synthetic Checking',
} as const;

describe('account/card API contracts', () => {
  it('accepts exact decimal-string account, card, and bill values', () => {
    expect(accountSummarySchema.parse(baseAccount)).toEqual(baseAccount);
    expect(
      cardSummarySchema.parse({
        ...baseAccount,
        accountType: 'CREDIT_CARD',
        availableCreditLimit: { currency: 'BRL', value: '7000.000001' },
        closingDay: 20,
        creditLimit: { currency: 'BRL', value: '10000.000001' },
        dueDay: 28,
      }),
    ).toMatchObject({ accountType: 'CREDIT_CARD' });
    expect(
      cardBillSummarySchema.parse({
        allowsInstallments: true,
        cardId: baseAccount.id,
        closeDate: '2026-08-20',
        dueDate: '2026-08-28',
        id: '20000000-0000-4000-8000-000000000061',
        minimumPayment: { currency: 'BRL', value: '100.000001' },
        status: 'OPEN',
        totalAmount: { currency: 'BRL', value: '1000.000001' },
      }),
    ).toMatchObject({ status: 'OPEN' });
  });

  it('exposes normalized child evidence without provider identities', () => {
    const payment = cardBillPaymentSchema.parse({
      amount: { currency: 'BRL', value: '1000.000001' },
      id: '30000000-0000-4000-8000-000000000061',
      isMatchedToCardTransaction: false,
      paymentDate: '2026-08-27',
      paymentMode: 'PIX',
      valueType: 'FULL_PAYMENT',
    });
    const charge = cardBillFinanceChargeSchema.parse({
      additionalInfo: null,
      amount: { currency: 'BRL', value: '10.000001' },
      chargeType: 'IOF',
      id: '40000000-0000-4000-8000-000000000061',
      isMatchedToTransaction: false,
    });
    expect(JSON.stringify({ charge, payment })).not.toMatch(/provider|external|raw/iu);
  });

  it('rejects numeric money and unknown response fields', () => {
    expect(() =>
      accountSummarySchema.parse({
        ...baseAccount,
        currentBalance: { currency: 'BRL', value: 1000.12 },
      }),
    ).toThrow();
    expect(() =>
      accountSummarySchema.parse({ ...baseAccount, externalAccountId: 'forbidden' }),
    ).toThrow();
  });
});
