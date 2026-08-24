import { z } from 'zod';

const boundedTextSchema = z.string().trim().min(1).max(1_000);
const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u, 'Expected an exact decimal string.');
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const bankDateSchema = z.iso.date();
const categorySchema = z
  .object({
    code: boundedTextSchema,
    id: z.uuid(),
    name: boundedTextSchema,
  })
  .strict()
  .nullable();
const merchantSchema = z
  .object({
    id: z.uuid(),
    name: boundedTextSchema,
  })
  .strict()
  .nullable();

export const missingEnrichmentWarningCodes = [
  'MISSING_CATEGORY',
  'MISSING_MERCHANT',
  'UNCONVERTED_CURRENCY',
] as const;

export type MissingEnrichmentWarningCode = (typeof missingEnrichmentWarningCodes)[number];

const warningCodesSchema = z.array(z.enum(missingEnrichmentWarningCodes)).max(3);

export const webUnclassifiedTransactionSchema = z
  .object({
    amount: z
      .object({
        currency: currencySchema,
        hasUnconvertedCurrency: z.boolean(),
        value: decimalStringSchema.nullable(),
      })
      .strict(),
    category: categorySchema,
    classificationState: z.literal('UNCLASSIFIED'),
    description: z.object({ original: boundedTextSchema, normalized: boundedTextSchema }).strict(),
    id: z.uuid(),
    merchant: merchantSchema,
    providerCategoryName: boundedTextSchema.nullable(),
    transactionDate: bankDateSchema,
    warnings: warningCodesSchema,
  })
  .strict();

export type WebUnclassifiedTransaction = z.output<typeof webUnclassifiedTransactionSchema>;

const mcpSupportingFactSchema = z
  .object({
    amountSigned: decimalStringSchema.nullable(),
    category: categorySchema,
    financialRole: boundedTextSchema,
    merchant: merchantSchema,
    transactionDate: bankDateSchema,
    warnings: warningCodesSchema,
  })
  .strict();

export const mcpUnclassifiedSummarySchema = z
  .object({
    asOf: z.iso.datetime({ offset: true }),
    currency: currencySchema,
    freshnessWarning: boundedTextSchema.nullable(),
    policyVersion: boundedTextSchema,
    requestedPeriod: z
      .object({ from: bankDateSchema, to: bankDateSchema })
      .strict()
      .refine(({ from, to }) => from <= to, 'Requested period must be ordered.'),
    sample: z.array(mcpSupportingFactSchema).max(20),
    unclassifiedCount: z.number().int().nonnegative(),
  })
  .strict();

export type McpUnclassifiedSummary = z.output<typeof mcpUnclassifiedSummarySchema>;
