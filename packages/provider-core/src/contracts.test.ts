import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  cursorPageSchema,
  listTransactionsInputSchema,
  providerAccountSchema,
  providerBillSchema,
  providerConnectionLocalStatuses,
  providerConnectionSchema,
  providerCreditCardMetadataSchema,
  providerTransactionSchema,
  type FinancialDataProvider,
  type ProviderAccountDto,
} from './index.js';

const raw = { synthetic: true };

describe('provider-neutral runtime contracts', () => {
  it.each(providerConnectionLocalStatuses)(
    'accepts the %s connection lifecycle state',
    (status) => {
      expect(
        providerConnectionSchema.parse({
          externalConnectionId: 'connection-1',
          externalConnectorId: 'connector-1',
          displayName: 'Synthetic Bank',
          localStatus: status,
          itemStatus: null,
          executionStatus: null,
          errorCode: null,
          actionRequiredAt: null,
          consentExpiresAt: null,
          providerUpdatedAt: '2026-08-23T12:00:00-03:00',
          raw,
        }).localStatus,
      ).toBe(status);
    },
  );

  it('validates accounts with exact balances and masked identifiers only', () => {
    const account = providerAccountSchema.parse({
      externalAccountId: 'account-1',
      externalConnectionId: 'connection-1',
      accountType: 'CREDIT_CARD',
      accountSubtype: null,
      name: 'Synthetic card',
      institutionName: 'Synthetic Bank',
      currency: 'BRL',
      maskedNumber: '0042',
      currentBalance: '1234.560000',
      availableBalance: null,
      creditLimit: '5000.00',
      availableCreditLimit: '3765.44',
      closingDay: 10,
      dueDay: 17,
      isActive: true,
      providerUpdatedAt: null,
      raw,
    });

    expect(account.currentBalance).toBe('1234.56');
    expect(account.creditLimit).toBe('5000');
    expectTypeOf(account).toMatchTypeOf<ProviderAccountDto>();
    expect(providerAccountSchema.safeParse({ ...account, maskedNumber: '12345' }).success).toBe(
      false,
    );
  });

  it('preserves signed original and account-currency transaction values', () => {
    const transaction = providerTransactionSchema.parse({
      externalTransactionId: 'transaction-1',
      providerId: null,
      providerCode: null,
      externalAccountId: 'account-1',
      status: 'POSTED',
      providerType: 'CREDIT',
      amountSigned: '-20.100000',
      currency: 'USD',
      amountInAccountCurrencySigned: '-113.45',
      accountCurrency: 'BRL',
      transactionAt: '2026-08-23T09:30:00-03:00',
      purchaseAt: null,
      description: 'Synthetic refund',
      descriptionRaw: null,
      operationType: null,
      operationTypeAdditionalInfo: null,
      categoryId: null,
      categoryName: null,
      merchant: null,
      creditCardMetadata: null,
      raw,
    });

    expect(transaction.amountSigned).toBe('-20.1');
    expect(transaction.amountInAccountCurrencySigned).toBe('-113.45');
    expect(transaction.categoryName).toBeNull();
    expect(transaction.merchant).toBeNull();
    expect(JSON.stringify(transaction)).toContain('"amountSigned":"-20.1"');
  });

  it('rejects numeric money, implicit-zone timestamps, and invalid currencies', () => {
    const valid = {
      externalTransactionId: null,
      providerId: null,
      providerCode: null,
      externalAccountId: 'account-1',
      status: 'UNKNOWN',
      providerType: null,
      amountSigned: '1.00',
      currency: 'BRL',
      amountInAccountCurrencySigned: null,
      accountCurrency: 'BRL',
      transactionAt: '2026-08-23T12:00:00Z',
      purchaseAt: null,
      description: 'Synthetic transaction',
      descriptionRaw: null,
      operationType: null,
      operationTypeAdditionalInfo: null,
      categoryId: null,
      categoryName: null,
      merchant: null,
      creditCardMetadata: null,
      raw,
    };

    expect(providerTransactionSchema.safeParse({ ...valid, amountSigned: 1 }).success).toBe(false);
    expect(
      providerTransactionSchema.safeParse({ ...valid, transactionAt: '2026-08-23T12:00:00' })
        .success,
    ).toBe(false);
    expect(providerTransactionSchema.safeParse({ ...valid, currency: 'brl' }).success).toBe(false);
  });

  it('requires coherent installment metadata', () => {
    const metadata = {
      installmentNumber: 2,
      totalInstallments: 10,
      totalAmount: '1000.00',
      mcc: '5812',
      cardLastFour: '0042',
      billId: 'bill-1',
      billForecastMonth: '2026-08',
      feeType: null,
      feeTypeAdditionalInfo: null,
      otherCreditType: null,
      otherCreditAdditionalInfo: null,
    };

    expect(providerCreditCardMetadataSchema.parse(metadata).billForecastMonth).toBe('2026-08');
    expect(
      providerCreditCardMetadataSchema.safeParse({ ...metadata, installmentNumber: 11 }).success,
    ).toBe(false);
    expect(
      providerCreditCardMetadataSchema.safeParse({ ...metadata, totalInstallments: null }).success,
    ).toBe(false);
  });

  it('validates bill payments and charges as non-negative child evidence', () => {
    const bill = providerBillSchema.parse({
      externalBillId: 'bill-1',
      externalAccountId: 'account-1',
      status: 'OPEN',
      providerStatus: null,
      dueDate: '2026-09-17',
      closeDate: '2026-09-10',
      totalAmount: '1250.40',
      minimumPayment: null,
      currency: 'BRL',
      allowsInstallments: null,
      payments: [
        {
          externalPaymentId: 'payment-1',
          valueType: 'TOTAL',
          paymentDate: '2026-08-17',
          paymentMode: null,
          amount: '1200.00',
          currency: 'BRL',
          raw,
        },
      ],
      financeCharges: [
        {
          externalChargeId: 'charge-1',
          chargeType: 'INTEREST',
          amount: '50.40',
          currency: 'BRL',
          additionalInfo: null,
          raw,
        },
      ],
      providerUpdatedAt: null,
      raw,
    });

    expect(bill.payments[0]?.amount).toBe('1200');
    expect(bill.financeCharges[0]?.amount).toBe('50.4');
    expect(
      providerBillSchema.safeParse({
        ...bill,
        payments: [{ ...bill.payments[0], amount: '-1' }],
      }).success,
    ).toBe(false);
  });

  it('validates cursor inputs and pages without page-number semantics', () => {
    expect(
      listTransactionsInputSchema.parse({ externalAccountId: 'account-1', cursor: null }),
    ).toEqual({ externalAccountId: 'account-1', cursor: null });

    const page = cursorPageSchema(providerTransactionSchema).parse({
      items: [],
      nextCursor: 'opaque-cursor',
    });
    expect(page.nextCursor).toBe('opaque-cursor');
  });

  it('defines the complete neutral provider interface without an implementation dependency', () => {
    expectTypeOf<FinancialDataProvider>().toHaveProperty('listConnections');
    expectTypeOf<FinancialDataProvider>().toHaveProperty('listTransactions');
    expectTypeOf<FinancialDataProvider>().toHaveProperty('listCreditCardBills');
  });
});
