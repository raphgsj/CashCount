import { z } from 'zod';

export const transactionStatuses = ['PENDING', 'POSTED', 'UNKNOWN'] as const;
export const transactionReviewStatuses = [
  'UNREVIEWED',
  'NEEDS_REVIEW',
  'CONFIRMED',
  'IGNORED',
] as const;
export const financialRoles = [
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

const uuidSchema = z.uuid();
const dateSchema = z.iso.date();
const timestampSchema = z.iso.datetime({ offset: true });
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u, 'Expected an exact decimal string.');
const boundedTextSchema = z.string().trim().min(1).max(1_000);
const namedReferenceSchema = z.object({ id: uuidSchema, name: boundedTextSchema }).strict();
const moneySchema = z.object({ currency: currencySchema, value: decimalStringSchema }).strict();
const nullableOverrideStateSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('INHERIT') }).strict(),
  z.object({ mode: z.literal('CLEAR') }).strict(),
  z.object({ id: uuidSchema, mode: z.literal('SET') }).strict(),
]);
const valueOverrideStateSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('INHERIT') }).strict(),
    z.object({ mode: z.literal('SET'), value }).strict(),
  ]);

export const transactionWarningSchema = z.discriminatedUnion('code', [
  z
    .object({
      accountCurrency: currencySchema,
      accountId: uuidSchema,
      code: z.literal('UNCONVERTED_CURRENCY'),
      originalCurrency: currencySchema,
    })
    .strict(),
  z
    .object({
      accountId: uuidSchema,
      code: z.literal('INCOMPLETE_HISTORY'),
      coverageStatus: z.enum([
        'UNKNOWN',
        'PARTIAL',
        'PROVIDER_MAXIMUM_RETRIEVED',
        'USER_EXTENDED_HISTORY',
      ]),
      earliestKnownDate: dateSchema.nullable(),
      requestedFrom: dateSchema,
    })
    .strict(),
  z
    .object({
      accountId: uuidSchema,
      code: z.literal('STALE_DATA'),
      lastSuccessfulSyncAt: timestampSchema.nullable(),
    })
    .strict(),
  z.object({ accountId: uuidSchema, code: z.literal('CONNECTION_ATTENTION') }).strict(),
]);

export const transactionSchema = z
  .object({
    account: z
      .object({
        accountType: z.enum(['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'INVESTMENT', 'OTHER']),
        id: uuidSchema,
        maskedNumber: z
          .string()
          .regex(/^[0-9]{1,4}$/u)
          .nullable(),
        name: boundedTextSchema,
      })
      .strict(),
    accountCurrencyAmount: moneySchema.nullable(),
    analyticsAmount: moneySchema.nullable(),
    bill: z
      .object({
        closeDate: dateSchema.nullable(),
        dueDate: dateSchema.nullable(),
        id: uuidSchema,
        status: boundedTextSchema,
      })
      .strict()
      .nullable(),
    card: z
      .object({
        billForecastMonth: dateSchema.nullable(),
        installmentNumber: z.number().int().positive().nullable(),
        installmentTotal: z.number().int().positive().nullable(),
        installmentTotalAmount: moneySchema.nullable(),
        lastFour: z
          .string()
          .regex(/^[0-9]{4}$/u)
          .nullable(),
        mcc: boundedTextSchema.nullable(),
      })
      .strict()
      .nullable(),
    description: boundedTextSchema,
    duplicateReviewStatus: z.enum([
      'NONE',
      'POSSIBLE',
      'CONFIRMED_DUPLICATE',
      'CONFIRMED_DISTINCT',
    ]),
    effective: z
      .object({
        category: z
          .object({
            override: nullableOverrideStateSchema,
            source: boundedTextSchema,
            value: namedReferenceSchema.nullable(),
          })
          .strict(),
        excludedFromSpend: z
          .object({
            override: valueOverrideStateSchema(z.boolean()),
            source: boundedTextSchema,
            value: z.boolean(),
          })
          .strict(),
        financialRole: z
          .object({
            override: valueOverrideStateSchema(z.enum(financialRoles)),
            source: boundedTextSchema,
            value: z.enum(financialRoles).nullable(),
          })
          .strict(),
        merchant: z
          .object({
            override: nullableOverrideStateSchema,
            source: boundedTextSchema,
            value: namedReferenceSchema.nullable(),
          })
          .strict(),
      })
      .strict(),
    freshness: z
      .object({
        isStale: z.boolean(),
        lastSuccessfulSyncAt: timestampSchema.nullable(),
        requiresConnectionAttention: z.boolean(),
      })
      .strict(),
    id: uuidSchema,
    localDate: dateSchema,
    notes: z.string().max(4_000).nullable(),
    originalAmount: moneySchema,
    purchaseAt: timestampSchema.nullable(),
    purchaseLocalDate: dateSchema.nullable(),
    replacementContext: z.array(
      z
        .object({
          confidence: decimalStringSchema.nullable(),
          relatedTransactionId: uuidSchema,
          relationship: z.enum(['PREDECESSOR', 'SUCCESSOR']),
          status: z.enum(['AUTO_CONFIRMED', 'NEEDS_REVIEW', 'USER_CONFIRMED', 'REJECTED']),
        })
        .strict(),
    ),
    reviewStatus: z.enum(transactionReviewStatuses),
    status: z.enum(transactionStatuses),
    tags: z.array(namedReferenceSchema).max(50),
    transactionAt: timestampSchema,
    userStateVersion: z.number().int().nonnegative(),
    warnings: z.array(transactionWarningSchema),
  })
  .strict();

const categoryOverridePatchSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('INHERIT') }).strict(),
  z.object({ mode: z.literal('CLEAR') }).strict(),
  z.object({ categoryId: uuidSchema, mode: z.literal('SET') }).strict(),
]);
const merchantOverridePatchSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('INHERIT') }).strict(),
  z.object({ mode: z.literal('CLEAR') }).strict(),
  z.object({ merchantId: uuidSchema, mode: z.literal('SET') }).strict(),
]);

export const transactionPatchSchema = z
  .object({
    categoryOverride: categoryOverridePatchSchema.optional(),
    excludedFromSpendOverride: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('INHERIT') }).strict(),
        z.object({ mode: z.literal('SET'), value: z.boolean() }).strict(),
      ])
      .optional(),
    expectedVersion: z.number().int().nonnegative(),
    financialRoleOverride: z
      .discriminatedUnion('mode', [
        z.object({ mode: z.literal('INHERIT') }).strict(),
        z.object({ mode: z.literal('SET'), value: z.enum(financialRoles) }).strict(),
      ])
      .optional(),
    merchantOverride: merchantOverridePatchSchema.optional(),
    notes: z.string().max(4_000).nullable().optional(),
    reviewStatus: z.enum(transactionReviewStatuses).optional(),
    tagIds: z.array(uuidSchema).max(50).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const mutableKeys = Object.keys(value).filter((key) => key !== 'expectedVersion');
    if (mutableKeys.length === 0) {
      context.addIssue({ code: 'custom', message: 'At least one user-owned field is required.' });
    }
    if (value.tagIds !== undefined && new Set(value.tagIds).size !== value.tagIds.length) {
      context.addIssue({ code: 'custom', message: 'Tag IDs must be unique.', path: ['tagIds'] });
    }
  });

export type FinancialRole = (typeof financialRoles)[number];
export type Transaction = z.infer<typeof transactionSchema>;
export type TransactionPatch = z.infer<typeof transactionPatchSchema>;
export type TransactionReviewStatus = (typeof transactionReviewStatuses)[number];
export type TransactionStatus = (typeof transactionStatuses)[number];
export type TransactionWarning = z.infer<typeof transactionWarningSchema>;
