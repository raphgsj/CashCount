import { RE2 } from 're2-wasm';
import { z } from 'zod';

export const classificationRuleDslVersion = '1' as const;
export const classificationRuleMaxDepth = 4;
export const classificationRuleMaxNodes = 50;
export const classificationRuleMaxConditionsPerGroup = 20;
export const classificationRuleMaxActions = 20;
export const classificationRuleMaxInValues = 50;
export const classificationRuleMaxDocumentBytes = 20_000;
export const classificationRuleMaxPatternLength = 256;
export const classificationRuleMaxRegexInputLength = 1_000;

export const classificationRuleFields = [
  'transaction.descriptionNormalized',
  'transaction.systemDirection',
  'transaction.systemFinancialRole',
  'transaction.providerType',
  'transaction.providerAmountSigned',
  'transaction.providerCurrency',
  'transaction.accountCurrencyAmountSigned',
  'transaction.accountCurrency',
  'transaction.accountId',
  'transaction.accountType',
  'transaction.transactionLocalDate',
  'transaction.installmentTotal',
  'merchant.id',
  'merchant.normalizedKey',
  'provider.categoryId',
] as const;

export const classificationRuleOperators = [
  'eq',
  'neq',
  'contains',
  'starts_with',
  'in',
  'between',
  'gt',
  'gte',
  'lt',
  'lte',
  'regex_safe',
] as const;

export const classificationRuleActionTypes = [
  'SET_CATEGORY',
  'SET_MERCHANT',
  'SET_FINANCIAL_ROLE',
  'SET_SPEND_INCLUSION',
  'ADD_TAG',
  'REMOVE_TAG',
  'MARK_RECURRING_CANDIDATE',
  'STOP_PROCESSING',
] as const;

const transactionDirections = ['INFLOW', 'OUTFLOW', 'NEUTRAL', 'UNKNOWN'] as const;
const transactionFinancialRoles = [
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
const providerTypes = ['DEBIT', 'CREDIT'] as const;
const accountTypes = ['CHECKING', 'SAVINGS', 'CREDIT_CARD', 'INVESTMENT', 'OTHER'] as const;

export type ClassificationRuleField = (typeof classificationRuleFields)[number];
export type ClassificationRuleOperator = (typeof classificationRuleOperators)[number];

export interface ClassificationRulePredicate {
  field: ClassificationRuleField;
  operator: ClassificationRuleOperator;
  type: 'PREDICATE';
  value: unknown;
}

export interface ClassificationRuleConditionGroup {
  combinator: 'ALL' | 'ANY';
  conditions: ClassificationRuleConditionNode[];
  type: 'GROUP';
}

export type ClassificationRuleConditionNode =
  ClassificationRuleConditionGroup | ClassificationRulePredicate;

export type ClassificationRuleAction =
  | { categoryId: string; type: 'SET_CATEGORY' }
  | { merchantId: string; type: 'SET_MERCHANT' }
  | { financialRole: (typeof transactionFinancialRoles)[number]; type: 'SET_FINANCIAL_ROLE' }
  | { inclusion: 'EXCLUDE' | 'INCLUDE'; type: 'SET_SPEND_INCLUSION' }
  | { tagId: string; type: 'ADD_TAG' | 'REMOVE_TAG' }
  | { type: 'MARK_RECURRING_CANDIDATE' }
  | { type: 'STOP_PROCESSING' };

export interface ClassificationRuleConditions {
  root: ClassificationRuleConditionNode;
  version: typeof classificationRuleDslVersion;
}

export interface ClassificationRuleActions {
  operations: ClassificationRuleAction[];
  version: typeof classificationRuleDslVersion;
}

export interface ClassificationRuleDsl {
  actions: ClassificationRuleActions;
  conditions: ClassificationRuleConditions;
}

const fieldSchema = z.enum(classificationRuleFields);
const operatorSchema = z.enum(classificationRuleOperators);
const uuidSchema = z.uuid();
function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

const safeTextSchema = z
  .string()
  .min(1)
  .max(1_000)
  .refine((value) => !containsControlCharacter(value), 'Control characters are not allowed');
const shortSafeTextSchema = safeTextSchema.max(200);
const currencySchema = z.string().regex(/^[A-Z]{3}$/u);
const decimalSchema = z
  .string()
  .regex(/^-?(?:0|[1-9]\d{0,13})(?:\.\d{1,6})?$/u, 'Expected a signed decimal string');
const positiveIntegerSchema = z.number().int().min(1).max(999);
const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const instant = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(instant.valueOf()) && instant.toISOString().slice(0, 10) === value;
  }, 'Expected a valid calendar date');

type FieldKind = 'DATE' | 'DECIMAL' | 'ENUM' | 'INTEGER' | 'STRING' | 'UUID';

interface FieldDefinition {
  kind: FieldKind;
  schema: z.ZodType;
}

const fieldDefinitions: Readonly<Record<ClassificationRuleField, FieldDefinition>> = {
  'transaction.descriptionNormalized': { kind: 'STRING', schema: safeTextSchema },
  'transaction.systemDirection': { kind: 'ENUM', schema: z.enum(transactionDirections) },
  'transaction.systemFinancialRole': {
    kind: 'ENUM',
    schema: z.enum(transactionFinancialRoles),
  },
  'transaction.providerType': { kind: 'ENUM', schema: z.enum(providerTypes) },
  'transaction.providerAmountSigned': { kind: 'DECIMAL', schema: decimalSchema },
  'transaction.providerCurrency': { kind: 'ENUM', schema: currencySchema },
  'transaction.accountCurrencyAmountSigned': { kind: 'DECIMAL', schema: decimalSchema },
  'transaction.accountCurrency': { kind: 'ENUM', schema: currencySchema },
  'transaction.accountId': { kind: 'UUID', schema: uuidSchema },
  'transaction.accountType': { kind: 'ENUM', schema: z.enum(accountTypes) },
  'transaction.transactionLocalDate': { kind: 'DATE', schema: localDateSchema },
  'transaction.installmentTotal': { kind: 'INTEGER', schema: positiveIntegerSchema },
  'merchant.id': { kind: 'UUID', schema: uuidSchema },
  'merchant.normalizedKey': { kind: 'STRING', schema: shortSafeTextSchema },
  'provider.categoryId': { kind: 'STRING', schema: shortSafeTextSchema },
};

const operatorsByKind: Readonly<Record<FieldKind, ReadonlySet<ClassificationRuleOperator>>> = {
  DATE: new Set(['eq', 'neq', 'in', 'between', 'gt', 'gte', 'lt', 'lte']),
  DECIMAL: new Set(['eq', 'neq', 'in', 'between', 'gt', 'gte', 'lt', 'lte']),
  ENUM: new Set(['eq', 'neq', 'in']),
  INTEGER: new Set(['eq', 'neq', 'in', 'between', 'gt', 'gte', 'lt', 'lte']),
  STRING: new Set(['eq', 'neq', 'contains', 'starts_with', 'in', 'regex_safe']),
  UUID: new Set(['eq', 'neq', 'in']),
};

function compilePattern(pattern: string): RE2 {
  return new RE2(pattern, 'iu');
}

export function compileSafeRulePattern(pattern: string): RE2 {
  if (pattern.length === 0 || pattern.length > classificationRuleMaxPatternLength) {
    throw new RangeError(
      `Pattern length must be between 1 and ${classificationRuleMaxPatternLength}`,
    );
  }
  if (containsControlCharacter(pattern)) {
    throw new TypeError('Pattern control characters are not allowed');
  }
  return compilePattern(pattern);
}

function addNestedIssues(
  context: z.RefinementCtx,
  result: z.ZodSafeParseResult<unknown>,
  path: PropertyKey[],
): void {
  if (result.success) {
    return;
  }
  for (const issue of result.error.issues) {
    context.addIssue({
      ...issue,
      path: [...path, ...issue.path],
    });
  }
}

function validatePredicateValue(
  predicate: ClassificationRulePredicate,
  context: z.RefinementCtx,
): void {
  const definition = fieldDefinitions[predicate.field];
  if (!operatorsByKind[definition.kind].has(predicate.operator)) {
    context.addIssue({
      code: 'custom',
      message: `Operator ${predicate.operator} is not supported for ${predicate.field}`,
      path: ['operator'],
    });
    return;
  }

  if (predicate.operator === 'in') {
    addNestedIssues(
      context,
      z
        .array(definition.schema)
        .min(1)
        .max(classificationRuleMaxInValues)
        .safeParse(predicate.value),
      ['value'],
    );
    return;
  }

  if (predicate.operator === 'between') {
    addNestedIssues(
      context,
      z.tuple([definition.schema, definition.schema]).safeParse(predicate.value),
      ['value'],
    );
    return;
  }

  if (predicate.operator === 'regex_safe') {
    const parsed = z
      .string()
      .min(1)
      .max(classificationRuleMaxPatternLength)
      .safeParse(predicate.value);
    addNestedIssues(context, parsed, ['value']);
    if (parsed.success) {
      try {
        compileSafeRulePattern(parsed.data);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'Invalid RE2 pattern',
          path: ['value'],
        });
      }
    }
    return;
  }

  addNestedIssues(context, definition.schema.safeParse(predicate.value), ['value']);
}

const predicateSchema = z
  .strictObject({
    type: z.literal('PREDICATE'),
    field: fieldSchema,
    operator: operatorSchema,
    value: z.unknown(),
  })
  .superRefine(validatePredicateValue);

const conditionNodeSchema: z.ZodType<ClassificationRuleConditionNode> = z.lazy(() =>
  z.union([
    predicateSchema,
    z.strictObject({
      type: z.literal('GROUP'),
      combinator: z.enum(['ALL', 'ANY']),
      conditions: z.array(conditionNodeSchema).min(1).max(classificationRuleMaxConditionsPerGroup),
    }),
  ]),
);

function inspectConditionTree(
  node: ClassificationRuleConditionNode,
  depth: number,
): { depth: number; nodes: number } {
  if (node.type === 'PREDICATE') {
    return { depth, nodes: 1 };
  }
  return node.conditions.reduce(
    (summary, child) => {
      const childSummary = inspectConditionTree(child, depth + 1);
      return {
        depth: Math.max(summary.depth, childSummary.depth),
        nodes: summary.nodes + childSummary.nodes,
      };
    },
    { depth, nodes: 1 },
  );
}

export const classificationRuleConditionsSchema: z.ZodType<ClassificationRuleConditions> = z
  .strictObject({
    version: z.literal(classificationRuleDslVersion),
    root: conditionNodeSchema,
  })
  .superRefine((conditions, context) => {
    const summary = inspectConditionTree(conditions.root, 1);
    if (summary.depth > classificationRuleMaxDepth) {
      context.addIssue({
        code: 'custom',
        message: `Condition depth must not exceed ${classificationRuleMaxDepth}`,
        path: ['root'],
      });
    }
    if (summary.nodes > classificationRuleMaxNodes) {
      context.addIssue({
        code: 'custom',
        message: `Condition count must not exceed ${classificationRuleMaxNodes}`,
        path: ['root'],
      });
    }
    if (
      new TextEncoder().encode(JSON.stringify(conditions)).length >
      classificationRuleMaxDocumentBytes
    ) {
      context.addIssue({
        code: 'custom',
        message: `Condition document must not exceed ${classificationRuleMaxDocumentBytes} UTF-8 bytes`,
      });
    }
  });

const actionSchema: z.ZodType<ClassificationRuleAction> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('SET_CATEGORY'), categoryId: uuidSchema }),
  z.strictObject({ type: z.literal('SET_MERCHANT'), merchantId: uuidSchema }),
  z.strictObject({
    type: z.literal('SET_FINANCIAL_ROLE'),
    financialRole: z.enum(transactionFinancialRoles),
  }),
  z.strictObject({
    type: z.literal('SET_SPEND_INCLUSION'),
    inclusion: z.enum(['INCLUDE', 'EXCLUDE']),
  }),
  z.strictObject({ type: z.literal('ADD_TAG'), tagId: uuidSchema }),
  z.strictObject({ type: z.literal('REMOVE_TAG'), tagId: uuidSchema }),
  z.strictObject({ type: z.literal('MARK_RECURRING_CANDIDATE') }),
  z.strictObject({ type: z.literal('STOP_PROCESSING') }),
]);

export const classificationRuleActionsSchema: z.ZodType<ClassificationRuleActions> = z
  .strictObject({
    version: z.literal(classificationRuleDslVersion),
    operations: z.array(actionSchema).min(1).max(classificationRuleMaxActions),
  })
  .superRefine((actions, context) => {
    const singletonTypes = new Set<string>();
    const addedTags = new Set<string>();
    const removedTags = new Set<string>();
    for (const [index, action] of actions.operations.entries()) {
      if (action.type === 'ADD_TAG') {
        if (addedTags.has(action.tagId) || removedTags.has(action.tagId)) {
          context.addIssue({
            code: 'custom',
            message: 'A tag may be changed only once in a rule',
            path: ['operations', index, 'tagId'],
          });
        }
        addedTags.add(action.tagId);
        continue;
      }
      if (action.type === 'REMOVE_TAG') {
        if (removedTags.has(action.tagId) || addedTags.has(action.tagId)) {
          context.addIssue({
            code: 'custom',
            message: 'A tag may be changed only once in a rule',
            path: ['operations', index, 'tagId'],
          });
        }
        removedTags.add(action.tagId);
        continue;
      }
      if (singletonTypes.has(action.type)) {
        context.addIssue({
          code: 'custom',
          message: `Action ${action.type} may appear only once`,
          path: ['operations', index, 'type'],
        });
      }
      singletonTypes.add(action.type);
    }
    if (
      new TextEncoder().encode(JSON.stringify(actions)).length > classificationRuleMaxDocumentBytes
    ) {
      context.addIssue({
        code: 'custom',
        message: `Action document must not exceed ${classificationRuleMaxDocumentBytes} UTF-8 bytes`,
      });
    }
  });

export const classificationRuleDslSchema: z.ZodType<ClassificationRuleDsl> = z.strictObject({
  conditions: classificationRuleConditionsSchema,
  actions: classificationRuleActionsSchema,
});

export function parseClassificationRuleDsl(input: unknown): ClassificationRuleDsl {
  return classificationRuleDslSchema.parse(input);
}

export function testSafeRulePattern(pattern: string, input: string): boolean {
  if (input.length > classificationRuleMaxRegexInputLength) {
    throw new RangeError(
      `Regex input length must not exceed ${classificationRuleMaxRegexInputLength}`,
    );
  }
  return compileSafeRulePattern(pattern).test(input);
}
