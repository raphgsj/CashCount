import { z } from 'zod';

const uuidSchema = z.uuid();
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableBoundedText = (maximum: number) => boundedText(maximum).nullable();
const jsonObjectSchema = z.record(z.string(), z.unknown());
const dateSchema = z.iso.date();

export const categoryKinds = ['EXPENSE', 'INCOME', 'TRANSFER', 'OTHER'] as const;
export const merchantReviewStatuses = ['AUTO', 'CONFIRMED', 'NEEDS_REVIEW'] as const;

export const managedCategorySchema = z
  .object({
    code: boundedText(200),
    iconKey: nullableBoundedText(100),
    id: uuidSchema,
    isActive: z.boolean(),
    kind: z.enum(categoryKinds),
    nameEn: boundedText(200),
    namePtBr: boundedText(200),
    parentId: uuidSchema.nullable(),
    scope: z.enum(['BUILT_IN', 'WORKSPACE']),
    sortOrder: z.number().int(),
  })
  .strict();

export const categoryCreateSchema = z
  .object({
    iconKey: nullableBoundedText(100).optional(),
    kind: z.enum(categoryKinds),
    nameEn: boundedText(200),
    namePtBr: boundedText(200),
    parentId: uuidSchema.nullable().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .strict();

export const categoryPatchSchema = z
  .object({
    iconKey: nullableBoundedText(100).optional(),
    isActive: z.boolean().optional(),
    kind: z.enum(categoryKinds).optional(),
    nameEn: boundedText(200).optional(),
    namePtBr: boundedText(200).optional(),
    parentId: uuidSchema.nullable().optional(),
    sortOrder: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one category field is required.');

export const managedMerchantAliasSchema = z
  .object({
    alias: boundedText(1_000),
    confidence: z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u),
    id: uuidSchema,
    isActive: z.boolean(),
    isConfirmed: z.boolean(),
    matchType: z.enum(['EXACT', 'PREFIX', 'CONTAINS', 'REGEX']),
    source: z.enum(['USER', 'PROVIDER', 'HEURISTIC', 'IMPORT']),
  })
  .strict();

export const managedMerchantSchema = z
  .object({
    aliases: z.array(managedMerchantAliasSchema).max(100),
    canonicalName: boundedText(500),
    defaultCategoryId: uuidSchema.nullable(),
    id: uuidSchema,
    mcc: z
      .string()
      .regex(/^\d{4}$/u)
      .nullable(),
    merchantGroup: nullableBoundedText(500),
    reviewStatus: z.enum(merchantReviewStatuses),
  })
  .strict();

export const merchantPatchSchema = z
  .object({
    canonicalName: boundedText(500).optional(),
    defaultCategoryId: uuidSchema.nullable().optional(),
    mcc: z
      .string()
      .regex(/^\d{4}$/u)
      .nullable()
      .optional(),
    merchantGroup: nullableBoundedText(500).optional(),
    reviewStatus: z.enum(merchantReviewStatuses).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one merchant field is required.');

export const merchantMergeSchema = z
  .object({ sourceMerchantId: uuidSchema, targetMerchantId: uuidSchema })
  .strict()
  .refine(
    ({ sourceMerchantId, targetMerchantId }) => sourceMerchantId !== targetMerchantId,
    'Source and target merchants must differ.',
  );

export const managedClassificationRuleSchema = z
  .object({
    actions: jsonObjectSchema,
    conditions: jsonObjectSchema,
    createdAt: z.iso.datetime({ offset: true }),
    hitCount: z.string().regex(/^\d+$/u),
    id: uuidSchema,
    isActive: z.boolean(),
    name: boundedText(200),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
    source: z.enum(['IMPORT', 'SYSTEM_SUGGESTION', 'USER']),
    stopProcessing: z.boolean(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const classificationRuleCreateSchema = z
  .object({
    actions: jsonObjectSchema,
    conditions: jsonObjectSchema,
    name: boundedText(200),
    priority: z.number().int().min(-1_000_000).max(1_000_000),
    stopProcessing: z.boolean().optional(),
  })
  .strict();

export const classificationRulePatchSchema = z
  .object({
    actions: jsonObjectSchema.optional(),
    conditions: jsonObjectSchema.optional(),
    isActive: z.boolean().optional(),
    name: boundedText(200).optional(),
    priority: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    stopProcessing: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one rule field is required.');

export const classificationRulePreviewSchema = z
  .object({
    from: dateSchema,
    limit: z.number().int().min(1).max(100).default(50),
    to: dateSchema,
  })
  .strict()
  .refine(({ from, to }) => from <= to, 'Preview from must not exceed to.');

export const classificationRulePreviewResultSchema = z
  .object({
    matches: z.array(
      z
        .object({
          description: boundedText(1_000),
          localDate: dateSchema,
          transactionId: uuidSchema,
          wouldStopProcessing: z.boolean(),
        })
        .strict(),
    ),
    policyVersion: boundedText(100),
    scannedCount: z.number().int().nonnegative().max(500),
    truncated: z.boolean(),
  })
  .strict();

export type CategoryCreate = z.infer<typeof categoryCreateSchema>;
export type CategoryPatch = z.infer<typeof categoryPatchSchema>;
export type ClassificationRuleCreate = z.infer<typeof classificationRuleCreateSchema>;
export type ClassificationRulePatch = z.infer<typeof classificationRulePatchSchema>;
export type ClassificationRulePreview = z.infer<typeof classificationRulePreviewSchema>;
export type ManagedCategory = z.infer<typeof managedCategorySchema>;
export type ManagedClassificationRule = z.infer<typeof managedClassificationRuleSchema>;
export type ManagedMerchant = z.infer<typeof managedMerchantSchema>;
export type MerchantMerge = z.infer<typeof merchantMergeSchema>;
export type MerchantPatch = z.infer<typeof merchantPatchSchema>;
