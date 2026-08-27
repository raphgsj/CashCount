import { z } from 'zod';

const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const dateSchema = z.iso.date();
const timestampSchema = z.iso.datetime({ offset: true });
const decimalStringSchema = z
  .string()
  .regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u, 'Expected an exact decimal string.');
const statusSchema = z.enum(['PENDING', 'POSTED']);

export const analyticsGranularitySchema = z.enum(['DAY', 'WEEK', 'MONTH']);

export const spendingMetricsSchema = z
  .object({
    grossSpending: decimalStringSchema,
    netSpending: decimalStringSchema,
    refundTotal: decimalStringSchema,
    transactionCount: z.number().int().nonnegative(),
  })
  .strict();

export const cashFlowMetricsSchema = z
  .object({
    inflowTotal: decimalStringSchema,
    netCashFlow: decimalStringSchema,
    outflowTotal: decimalStringSchema,
    transactionCount: z.number().int().nonnegative(),
  })
  .strict();

export const spendingCashFlowWarningSchema = z.discriminatedUnion('code', [
  z
    .object({
      affectedAccountCount: z.number().int().positive(),
      code: z.literal('INCOMPLETE_HISTORY'),
      coverageStatuses: z
        .array(
          z.enum(['UNKNOWN', 'PARTIAL', 'PROVIDER_MAXIMUM_RETRIEVED', 'USER_EXTENDED_HISTORY']),
        )
        .max(4),
      earliestKnownDate: dateSchema.nullable(),
      requestedFrom: dateSchema,
    })
    .strict(),
  z
    .object({
      code: z.literal('UNCONVERTED_CURRENCY'),
      excludedTransactionCount: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      affectedBillCount: z.number().int().positive(),
      code: z.literal('UNRECONCILED_BILL'),
    })
    .strict(),
  z
    .object({ affectedAccountCount: z.number().int().positive(), code: z.literal('STALE_DATA') })
    .strict(),
  z
    .object({
      affectedAccountCount: z.number().int().positive(),
      code: z.literal('CONNECTION_ATTENTION'),
    })
    .strict(),
  z
    .object({
      code: z.literal('BREAKDOWN_TRUNCATED'),
      dimensions: z
        .array(z.enum(['CATEGORY', 'MERCHANT']))
        .min(1)
        .max(2),
      limit: z.literal(100),
    })
    .strict(),
]);

const totalSchema = z
  .object({
    cashFlow: cashFlowMetricsSchema,
    currency: currencySchema,
    spending: spendingMetricsSchema,
    status: statusSchema,
  })
  .strict();

const breakdownSchema = spendingMetricsSchema
  .extend({
    currency: currencySchema,
    label: z.string().trim().min(1).max(500).nullable(),
    status: statusSchema,
  })
  .strict();

const timePointSchema = totalSchema
  .extend({
    periodStart: dateSchema,
  })
  .strict();

export const spendingCashFlowDataSchema = z
  .object({
    categoryBreakdown: z.array(breakdownSchema).max(100),
    from: dateSchema,
    granularity: analyticsGranularitySchema,
    includePending: z.boolean(),
    merchantBreakdown: z.array(breakdownSchema).max(100),
    timeSeries: z.array(timePointSchema).max(15_000),
    to: dateSchema,
    totals: z.array(totalSchema).max(200),
  })
  .strict();

export const analyticsFreshnessSchema = z
  .object({
    isStale: z.boolean(),
    lastSuccessfulSyncAt: timestampSchema.nullable(),
    oldestAccountSyncAt: timestampSchema.nullable(),
    staleAfterMinutes: z.literal(1440),
  })
  .strict();

export type AnalyticsFreshness = z.infer<typeof analyticsFreshnessSchema>;
export type SpendingCashFlowData = z.infer<typeof spendingCashFlowDataSchema>;
export type SpendingCashFlowWarning = z.infer<typeof spendingCashFlowWarningSchema>;
