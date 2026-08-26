import { z } from 'zod';

const boundedTextSchema = z.string().trim().min(1).max(1_000);
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u, 'Expected an exact decimal string.');
const moneySchema = z
  .object({ currency: currencySchema, value: decimalStringSchema })
  .strict()
  .nullable();
const instantSchema = z.iso.datetime({ offset: true });
const dateSchema = z.iso.date();

export const accountTypes = ['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'INVESTMENT', 'OTHER'] as const;

export const accountSummarySchema = z
  .object({
    accountSubtype: boundedTextSchema.nullable(),
    accountType: z.enum(accountTypes),
    availableBalance: moneySchema,
    currentBalance: moneySchema,
    historyCoverage: z
      .object({
        earliestDate: dateSchema.nullable(),
        latestDate: dateSchema.nullable(),
        status: z.enum([
          'UNKNOWN',
          'PARTIAL',
          'PROVIDER_MAXIMUM_RETRIEVED',
          'USER_EXTENDED_HISTORY',
        ]),
      })
      .strict(),
    id: z.uuid(),
    institutionName: boundedTextSchema,
    isActive: z.boolean(),
    lastSuccessfulSyncAt: instantSchema.nullable(),
    maskedNumber: z
      .string()
      .regex(/^[0-9]{1,4}$/u)
      .nullable(),
    name: boundedTextSchema,
  })
  .strict();

export const cardSummarySchema = accountSummarySchema
  .extend({
    accountType: z.literal('CREDIT_CARD'),
    availableCreditLimit: moneySchema,
    closingDay: z.number().int().min(1).max(31).nullable(),
    creditLimit: moneySchema,
    dueDay: z.number().int().min(1).max(31).nullable(),
  })
  .strict();

export const cardBillSummarySchema = z
  .object({
    allowsInstallments: z.boolean().nullable(),
    cardId: z.uuid(),
    closeDate: dateSchema.nullable(),
    dueDate: dateSchema.nullable(),
    id: z.uuid(),
    minimumPayment: moneySchema,
    status: boundedTextSchema,
    totalAmount: moneySchema,
  })
  .strict();

export const cardBillPaymentSchema = z
  .object({
    amount: z.object({ currency: currencySchema, value: decimalStringSchema }).strict(),
    id: z.uuid(),
    isMatchedToCardTransaction: z.boolean(),
    paymentDate: dateSchema,
    paymentMode: boundedTextSchema.nullable(),
    valueType: boundedTextSchema,
  })
  .strict();

export const cardBillFinanceChargeSchema = z
  .object({
    additionalInfo: boundedTextSchema.nullable(),
    amount: z.object({ currency: currencySchema, value: decimalStringSchema }).strict(),
    chargeType: boundedTextSchema,
    id: z.uuid(),
    isMatchedToTransaction: z.boolean(),
  })
  .strict();

export type AccountSummary = z.output<typeof accountSummarySchema>;
export type CardSummary = z.output<typeof cardSummarySchema>;
export type CardBillSummary = z.output<typeof cardBillSummarySchema>;
export type CardBillPayment = z.output<typeof cardBillPaymentSchema>;
export type CardBillFinanceCharge = z.output<typeof cardBillFinanceChargeSchema>;
