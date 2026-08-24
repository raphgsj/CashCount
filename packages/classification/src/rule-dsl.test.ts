import { describe, expect, it } from 'vitest';

import {
  classificationRuleActionsSchema,
  classificationRuleConditionsSchema,
  classificationRuleDslSchema,
  classificationRuleMaxConditionsPerGroup,
  classificationRuleMaxDepth,
  classificationRuleMaxInValues,
  classificationRuleMaxPatternLength,
  classificationRuleMaxRegexInputLength,
  parseClassificationRuleDsl,
  testSafeRulePattern,
  type ClassificationRuleConditionNode,
} from './rule-dsl.js';

const accountId = '11111111-1111-4111-8111-111111111111';
const categoryId = '22222222-2222-4222-8222-222222222222';
const merchantId = '33333333-3333-4333-8333-333333333333';
const tagId = '44444444-4444-4444-8444-444444444444';

function predicate(field: string, operator: string, value: unknown): Record<string, unknown> {
  return { type: 'PREDICATE', field, operator, value };
}

function conditions(root: unknown): Record<string, unknown> {
  return { version: '1', root };
}

describe('classification rule DSL', () => {
  it('accepts the complete constrained field and action vocabulary', () => {
    const parsed = parseClassificationRuleDsl({
      conditions: conditions({
        type: 'GROUP',
        combinator: 'ALL',
        conditions: [
          predicate('transaction.descriptionNormalized', 'contains', 'mercado'),
          predicate('transaction.systemDirection', 'eq', 'OUTFLOW'),
          predicate('transaction.systemFinancialRole', 'in', ['PURCHASE', 'FEE']),
          predicate('transaction.providerType', 'neq', 'CREDIT'),
          predicate('transaction.providerAmountSigned', 'between', ['-100.000001', '-1']),
          predicate('transaction.providerCurrency', 'eq', 'BRL'),
          predicate('transaction.accountCurrencyAmountSigned', 'gte', '-100'),
          predicate('transaction.accountCurrency', 'in', ['BRL', 'USD']),
          predicate('transaction.accountId', 'eq', accountId),
          predicate('transaction.accountType', 'eq', 'CREDIT_CARD'),
          predicate('transaction.transactionLocalDate', 'between', ['2026-01-01', '2026-12-31']),
          predicate('transaction.installmentTotal', 'lte', 12),
          predicate('merchant.id', 'in', [merchantId]),
          predicate('merchant.normalizedKey', 'starts_with', 'casa do pao'),
          predicate('provider.categoryId', 'regex_safe', '^food(?:-|$)'),
        ],
      }),
      actions: {
        version: '1',
        operations: [
          { type: 'SET_CATEGORY', categoryId },
          { type: 'SET_MERCHANT', merchantId },
          { type: 'SET_FINANCIAL_ROLE', financialRole: 'PURCHASE' },
          { type: 'SET_SPEND_INCLUSION', inclusion: 'EXCLUDE' },
          { type: 'ADD_TAG', tagId },
          { type: 'MARK_RECURRING_CANDIDATE' },
          { type: 'STOP_PROCESSING' },
        ],
      },
    });

    expect(parsed.conditions.version).toBe('1');
    expect(parsed.actions.operations).toHaveLength(7);
  });

  it('rejects unknown versions, fields, operators, keys, actions, and enum values', () => {
    const valid = predicate('transaction.descriptionNormalized', 'eq', 'padaria');
    expect(
      classificationRuleConditionsSchema.safeParse({ version: '2', root: valid }).success,
    ).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions(predicate('transaction.rawPayload', 'eq', 'secret')),
      ).success,
    ).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions(predicate('merchant.id', 'eval', 'x')),
      ).success,
    ).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions({ ...valid, javascript: 'return true' }),
      ).success,
    ).toBe(false);
    expect(
      classificationRuleActionsSchema.safeParse({
        version: '1',
        operations: [{ type: 'RUN_CODE', source: 'process.exit()' }],
      }).success,
    ).toBe(false);
    expect(
      classificationRuleActionsSchema.safeParse({
        version: '1',
        operations: [{ type: 'SET_FINANCIAL_ROLE', financialRole: 'SPEND' }],
      }).success,
    ).toBe(false);
  });

  it('enforces field-specific operators and values without JavaScript financial numbers', () => {
    const invalid = [
      predicate('merchant.id', 'contains', merchantId),
      predicate('transaction.providerCurrency', 'starts_with', 'B'),
      predicate('transaction.installmentTotal', 'regex_safe', '12'),
      predicate('transaction.providerAmountSigned', 'eq', 0.1),
      predicate('transaction.providerAmountSigned', 'eq', '01.00'),
      predicate('transaction.transactionLocalDate', 'eq', '2026-02-30'),
      predicate('transaction.accountId', 'eq', 'not-a-uuid'),
      predicate('transaction.installmentTotal', 'eq', 0),
      predicate('transaction.providerType', 'eq', 'UNKNOWN'),
      predicate('transaction.providerCurrency', 'eq', 'brl'),
      predicate('transaction.descriptionNormalized', 'contains', ''),
    ];

    for (const rule of invalid) {
      expect(classificationRuleConditionsSchema.safeParse(conditions(rule)).success).toBe(false);
    }
  });

  it('bounds condition depth, group width, total nodes, in-lists, text, and controls', () => {
    let deep: ClassificationRuleConditionNode = {
      type: 'PREDICATE',
      field: 'transaction.descriptionNormalized',
      operator: 'eq',
      value: 'safe',
    };
    for (let depth = 0; depth < classificationRuleMaxDepth; depth += 1) {
      deep = { type: 'GROUP', combinator: 'ALL', conditions: [deep] };
    }

    const wide = Array.from({ length: classificationRuleMaxConditionsPerGroup + 1 }, () =>
      predicate('transaction.descriptionNormalized', 'eq', 'safe'),
    );
    const tooManyNodes = {
      type: 'GROUP',
      combinator: 'ALL',
      conditions: Array.from({ length: 3 }, () => ({
        type: 'GROUP',
        combinator: 'ANY',
        conditions: Array.from({ length: classificationRuleMaxConditionsPerGroup }, () =>
          predicate('transaction.descriptionNormalized', 'eq', 'x'.repeat(400)),
        ),
      })),
    };
    expect(classificationRuleConditionsSchema.safeParse(conditions(deep)).success).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions({ type: 'GROUP', combinator: 'ALL', conditions: wide }),
      ).success,
    ).toBe(false);
    expect(classificationRuleConditionsSchema.safeParse(conditions(tooManyNodes)).success).toBe(
      false,
    );
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions(
          predicate(
            'transaction.accountType',
            'in',
            Array.from({ length: classificationRuleMaxInValues + 1 }, () => 'CHECKING'),
          ),
        ),
      ).success,
    ).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions(predicate('provider.categoryId', 'eq', 'x'.repeat(201))),
      ).success,
    ).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions(predicate('provider.categoryId', 'eq', 'food\u0000secret')),
      ).success,
    ).toBe(false);
  });

  it('uses RE2, rejects unsupported or oversized patterns, and bounds evaluated input', () => {
    expect(testSafeRulePattern('^casa\\s+do\\s+p[aã]o$', 'Casa do Pão')).toBe(true);
    expect(testSafeRulePattern('(a+)+$', `${'a'.repeat(500)}!`)).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions(predicate('transaction.descriptionNormalized', 'regex_safe', '(a)\\1')),
      ).success,
    ).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions(predicate('transaction.descriptionNormalized', 'regex_safe', '(?=unsafe)')),
      ).success,
    ).toBe(false);
    expect(
      classificationRuleConditionsSchema.safeParse(
        conditions(
          predicate(
            'transaction.descriptionNormalized',
            'regex_safe',
            'x'.repeat(classificationRuleMaxPatternLength + 1),
          ),
        ),
      ).success,
    ).toBe(false);
    expect(() =>
      testSafeRulePattern('safe', 'x'.repeat(classificationRuleMaxRegexInputLength + 1)),
    ).toThrow(RangeError);
  });

  it('rejects ambiguous duplicate and contradictory actions', () => {
    expect(
      classificationRuleActionsSchema.safeParse({
        version: '1',
        operations: [
          { type: 'SET_CATEGORY', categoryId },
          { type: 'SET_CATEGORY', categoryId: merchantId },
        ],
      }).success,
    ).toBe(false);
    expect(
      classificationRuleActionsSchema.safeParse({
        version: '1',
        operations: [
          { type: 'ADD_TAG', tagId },
          { type: 'REMOVE_TAG', tagId },
        ],
      }).success,
    ).toBe(false);
    expect(
      classificationRuleActionsSchema.safeParse({ version: '1', operations: [] }).success,
    ).toBe(false);
  });

  it('rejects a non-object combined document', () => {
    expect(classificationRuleDslSchema.safeParse('return true').success).toBe(false);
  });
});
