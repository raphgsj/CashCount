import {
  Money,
  accountTypes,
  parseBankDate,
  parseBillForecastMonth,
  parseCurrencyCode,
  parseDecimalString,
  parseInstant,
  type AccountType,
  type BankDate,
  type BillForecastMonth,
  type CurrencyCode,
  type DecimalString,
} from '@cashcount/domain';
import { z } from 'zod';

const nonEmptyIdSchema = z.string().trim().min(1).max(500);
const boundedTextSchema = z.string().trim().min(1).max(1_000);
const nullableBoundedTextSchema = boundedTextSchema.nullable();

function accepts<T>(parser: (value: string) => T): (value: string) => boolean {
  return (value) => {
    try {
      parser(value);
      return true;
    } catch {
      return false;
    }
  };
}

const decimalStringSchema = z
  .string()
  .refine(accepts(parseDecimalString), 'Expected an exact fixed-point decimal string.')
  .transform((value): DecimalString => parseDecimalString(value));

const nonNegativeDecimalStringSchema = decimalStringSchema.refine(
  (value) => !Money.from(value, 'XXX').isNegative(),
  'Expected a non-negative decimal magnitude.',
);

const currencyCodeSchema = z
  .string()
  .refine(accepts(parseCurrencyCode), 'Expected a three-letter uppercase currency code.')
  .transform((value): CurrencyCode => parseCurrencyCode(value));

const bankDateSchema = z
  .string()
  .refine(accepts(parseBankDate), 'Expected a valid calendar date in YYYY-MM-DD format.')
  .transform((value): BankDate => parseBankDate(value));

const billForecastMonthSchema = z
  .string()
  .refine(accepts(parseBillForecastMonth), 'Expected a valid month in YYYY-MM format.')
  .transform((value): BillForecastMonth => parseBillForecastMonth(value));

const instantSchema = z
  .string()
  .refine(accepts(parseInstant), 'Expected an ISO instant with an explicit UTC offset.');

const nullableInstantSchema = instantSchema.nullable();

/** Opaque provider evidence. It must be encrypted before persistence and must never be logged. */
const rawEvidenceSchema = z.unknown();

export const providerConnectionLocalStatuses = [
  'ACTIVE',
  'SYNCING',
  'USER_INPUT_REQUIRED',
  'USER_ACTION_REQUIRED',
  'REAUTH_REQUIRED',
  'PROVIDER_ERROR',
  'DELETED',
  'DISABLED',
] as const;

export type ProviderConnectionLocalStatus = (typeof providerConnectionLocalStatuses)[number];

export const providerConnectionSchema = z
  .object({
    externalConnectionId: nonEmptyIdSchema,
    externalConnectorId: nonEmptyIdSchema,
    displayName: boundedTextSchema,
    localStatus: z.enum(providerConnectionLocalStatuses),
    itemStatus: nullableBoundedTextSchema,
    executionStatus: nullableBoundedTextSchema,
    errorCode: nullableBoundedTextSchema,
    actionRequiredAt: nullableInstantSchema,
    consentExpiresAt: nullableInstantSchema,
    providerUpdatedAt: nullableInstantSchema,
    raw: rawEvidenceSchema,
  })
  .strict();

export type ProviderConnectionDto = z.output<typeof providerConnectionSchema>;

export const providerAccountTypes = accountTypes;

export const providerAccountSchema = z
  .object({
    externalAccountId: nonEmptyIdSchema,
    externalConnectionId: nonEmptyIdSchema,
    accountType: z.enum(providerAccountTypes),
    accountSubtype: nullableBoundedTextSchema,
    name: boundedTextSchema,
    institutionName: boundedTextSchema,
    currency: currencyCodeSchema,
    maskedNumber: z
      .string()
      .regex(/^\d{1,4}$/u)
      .nullable(),
    currentBalance: decimalStringSchema.nullable(),
    availableBalance: decimalStringSchema.nullable(),
    creditLimit: nonNegativeDecimalStringSchema.nullable(),
    availableCreditLimit: nonNegativeDecimalStringSchema.nullable(),
    closingDay: z.number().int().min(1).max(31).nullable(),
    dueDay: z.number().int().min(1).max(31).nullable(),
    isActive: z.boolean(),
    providerUpdatedAt: nullableInstantSchema,
    raw: rawEvidenceSchema,
  })
  .strict();

export type ProviderAccountDto = Omit<z.output<typeof providerAccountSchema>, 'accountType'> & {
  accountType: AccountType;
};

export const providerMerchantSchema = z
  .object({
    name: boundedTextSchema,
    businessName: nullableBoundedTextSchema,
  })
  .strict();

export type ProviderMerchantDto = z.output<typeof providerMerchantSchema>;

export const providerCreditCardMetadataSchema = z
  .object({
    installmentNumber: z.number().int().positive().nullable(),
    totalInstallments: z.number().int().positive().nullable(),
    totalAmount: nonNegativeDecimalStringSchema.nullable(),
    mcc: nullableBoundedTextSchema,
    cardLastFour: z
      .string()
      .regex(/^\d{4}$/u)
      .nullable(),
    billId: nonEmptyIdSchema.nullable(),
    billForecastMonth: billForecastMonthSchema.nullable(),
    feeType: nullableBoundedTextSchema,
    feeTypeAdditionalInfo: nullableBoundedTextSchema,
    otherCreditType: nullableBoundedTextSchema,
    otherCreditAdditionalInfo: nullableBoundedTextSchema,
  })
  .strict()
  .superRefine((metadata, context) => {
    const hasNumber = metadata.installmentNumber !== null;
    const hasTotal = metadata.totalInstallments !== null;
    if (hasNumber !== hasTotal) {
      context.addIssue({
        code: 'custom',
        message: 'Installment number and total must both be present or both be null.',
        path: ['installmentNumber'],
      });
    }

    if (
      metadata.installmentNumber !== null &&
      metadata.totalInstallments !== null &&
      metadata.installmentNumber > metadata.totalInstallments
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Installment number cannot exceed total installments.',
        path: ['installmentNumber'],
      });
    }
  });

export type ProviderCreditCardMetadataDto = z.output<typeof providerCreditCardMetadataSchema>;

export const providerTransactionStatuses = ['PENDING', 'POSTED', 'DELETED', 'UNKNOWN'] as const;

export type ProviderTransactionStatus = (typeof providerTransactionStatuses)[number];

export const providerTransactionSchema = z
  .object({
    externalTransactionId: nonEmptyIdSchema.nullable(),
    providerId: nonEmptyIdSchema.nullable(),
    providerCode: nonEmptyIdSchema.nullable(),
    externalAccountId: nonEmptyIdSchema,
    status: z.enum(providerTransactionStatuses),
    providerType: z.enum(['DEBIT', 'CREDIT']).nullable(),
    amountSigned: decimalStringSchema,
    currency: currencyCodeSchema,
    amountInAccountCurrencySigned: decimalStringSchema.nullable(),
    accountCurrency: currencyCodeSchema,
    transactionAt: instantSchema,
    purchaseAt: nullableInstantSchema,
    description: boundedTextSchema,
    descriptionRaw: nullableBoundedTextSchema,
    operationType: nullableBoundedTextSchema,
    operationTypeAdditionalInfo: nullableBoundedTextSchema,
    categoryId: nonEmptyIdSchema.nullable(),
    categoryName: nullableBoundedTextSchema,
    merchant: providerMerchantSchema.nullable(),
    creditCardMetadata: providerCreditCardMetadataSchema.nullable(),
    raw: rawEvidenceSchema,
  })
  .strict();

export type ProviderTransactionDto = z.output<typeof providerTransactionSchema>;

export const providerBillPaymentSchema = z
  .object({
    externalPaymentId: nonEmptyIdSchema,
    valueType: boundedTextSchema,
    paymentDate: bankDateSchema,
    paymentMode: nullableBoundedTextSchema,
    amount: nonNegativeDecimalStringSchema,
    currency: currencyCodeSchema,
    raw: rawEvidenceSchema,
  })
  .strict();

export type ProviderBillPaymentDto = z.output<typeof providerBillPaymentSchema>;

export const providerBillFinanceChargeSchema = z
  .object({
    externalChargeId: nonEmptyIdSchema,
    chargeType: boundedTextSchema,
    amount: nonNegativeDecimalStringSchema,
    currency: currencyCodeSchema,
    additionalInfo: nullableBoundedTextSchema,
    raw: rawEvidenceSchema,
  })
  .strict();

export type ProviderBillFinanceChargeDto = z.output<typeof providerBillFinanceChargeSchema>;

export const providerBillSchema = z
  .object({
    externalBillId: nonEmptyIdSchema,
    externalAccountId: nonEmptyIdSchema,
    status: boundedTextSchema,
    providerStatus: nullableBoundedTextSchema,
    dueDate: bankDateSchema.nullable(),
    closeDate: bankDateSchema.nullable(),
    totalAmount: nonNegativeDecimalStringSchema.nullable(),
    minimumPayment: nonNegativeDecimalStringSchema.nullable(),
    currency: currencyCodeSchema,
    allowsInstallments: z.boolean().nullable(),
    payments: z.array(providerBillPaymentSchema),
    financeCharges: z.array(providerBillFinanceChargeSchema),
    providerUpdatedAt: nullableInstantSchema,
    raw: rawEvidenceSchema,
  })
  .strict();

export type ProviderBillDto = z.output<typeof providerBillSchema>;

export const providerCategorySchema = z
  .object({
    externalCategoryId: nonEmptyIdSchema,
    parentExternalCategoryId: nonEmptyIdSchema.nullable(),
    name: boundedTextSchema,
  })
  .strict();

export type ProviderCategoryDto = z.output<typeof providerCategorySchema>;

export const listTransactionsInputSchema = z
  .object({
    externalAccountId: nonEmptyIdSchema,
    cursor: nonEmptyIdSchema.nullable(),
  })
  .strict();

export type ListTransactionsInput = z.output<typeof listTransactionsInputSchema>;

export const cursorPageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z
    .object({
      items: z.array(itemSchema),
      nextCursor: nonEmptyIdSchema.nullable(),
    })
    .strict();

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface FinancialDataProvider {
  listConnections(): Promise<ProviderConnectionDto[]>;
  getConnection(externalConnectionId: string): Promise<ProviderConnectionDto>;
  requestConnectionRefresh(externalConnectionId: string): Promise<void>;
  listAccounts(externalConnectionId: string): Promise<ProviderAccountDto[]>;
  listTransactions(input: ListTransactionsInput): Promise<CursorPage<ProviderTransactionDto>>;
  listCreditCardBills(externalAccountId: string): Promise<ProviderBillDto[]>;
  listCategories?(): Promise<ProviderCategoryDto[]>;
}
