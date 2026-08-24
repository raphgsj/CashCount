import { describe, expect, it } from 'vitest';

import {
  evaluateClassificationRules,
  type ClassificationRuleFacts,
  type EvaluatableClassificationRule,
} from './rule-evaluator.js';

const categoryA = '11111111-1111-4111-8111-111111111111';
const categoryB = '22222222-2222-4222-8222-222222222222';
const merchantA = '33333333-3333-4333-8333-333333333333';
const tagA = '44444444-4444-4444-8444-444444444444';

const facts: ClassificationRuleFacts = {
  transaction: {
    descriptionNormalized: 'casa do pão centro',
    systemDirection: 'OUTFLOW',
    systemFinancialRole: 'UNKNOWN',
    providerType: 'DEBIT',
    providerAmountSigned: '-10.250000',
    providerCurrency: 'BRL',
    accountCurrencyAmountSigned: '-10.250000',
    accountCurrency: 'BRL',
    accountId: '55555555-5555-4555-8555-555555555555',
    accountType: 'CREDIT_CARD',
    transactionLocalDate: '2026-08-24',
    installmentTotal: 3,
  },
  merchant: { id: merchantA, normalizedKey: 'casa do pao' },
  provider: { categoryId: null },
};

function rule(
  id: string,
  priority: number,
  field: string,
  operator: string,
  value: unknown,
  operations: unknown[],
  options: { createdAt?: string; stopProcessing?: boolean } = {},
): EvaluatableClassificationRule {
  return {
    id,
    priority,
    createdAt: options.createdAt ?? '2026-01-01T00:00:00.000Z',
    stopProcessing: options.stopProcessing ?? false,
    conditions: {
      version: '1',
      root: { type: 'PREDICATE', field, operator, value },
    },
    actions: { version: '1', operations },
  };
}

describe('classification rule evaluator', () => {
  it('evaluates decimal, date, text, in, and safe-regex predicates', () => {
    const rules = [
      rule(
        '1',
        5,
        'transaction.providerAmountSigned',
        'between',
        ['-11', '-10'],
        [{ type: 'SET_CATEGORY', categoryId: categoryA }],
      ),
      rule('2', 4, 'transaction.transactionLocalDate', 'gte', '2026-08-01', [
        { type: 'SET_MERCHANT', merchantId: merchantA },
      ]),
      rule('3', 3, 'transaction.descriptionNormalized', 'regex_safe', '^casa do p[aã]o', [
        { type: 'SET_FINANCIAL_ROLE', financialRole: 'PURCHASE' },
      ]),
      rule(
        '4',
        2,
        'transaction.accountType',
        'in',
        ['CHECKING', 'CREDIT_CARD'],
        [{ type: 'ADD_TAG', tagId: tagA }],
      ),
    ];

    const result = evaluateClassificationRules(rules, facts);
    expect(result.matchedRules).toHaveLength(4);
    expect(result.actions.category?.value).toBe(categoryA);
    expect(result.actions.merchant?.value).toBe(merchantA);
    expect(result.actions.financialRole?.value).toBe('PURCHASE');
    expect(result.actions.addedTags[0]?.value).toBe(tagA);
  });

  it('uses priority, createdAt, and id as deterministic precedence and reports conflicts', () => {
    const rules = [
      rule(
        'b',
        10,
        'transaction.systemDirection',
        'eq',
        'OUTFLOW',
        [{ type: 'SET_CATEGORY', categoryId: categoryB }],
        { createdAt: '2026-01-01T00:00:00.000Z' },
      ),
      rule('c', 20, 'transaction.systemDirection', 'eq', 'OUTFLOW', [
        { type: 'SET_CATEGORY', categoryId: categoryA },
      ]),
      rule(
        'a',
        10,
        'transaction.systemDirection',
        'eq',
        'OUTFLOW',
        [{ type: 'SET_CATEGORY', categoryId: categoryB }],
        { createdAt: '2026-01-01T00:00:00.000Z' },
      ),
    ];

    const result = evaluateClassificationRules(rules, facts);
    expect(result.actions.category).toEqual({ ruleId: 'c', value: categoryA });
    expect(result.matchedRules.map(({ ruleId }) => ruleId)).toEqual(['c', 'a', 'b']);
    expect(result.conflicts).toEqual([
      {
        field: 'categoryId',
        losingRuleId: 'a',
        losingValue: categoryB,
        winningRuleId: 'c',
        winningValue: categoryA,
      },
      {
        field: 'categoryId',
        losingRuleId: 'b',
        losingValue: categoryB,
        winningRuleId: 'c',
        winningValue: categoryA,
      },
    ]);
  });

  it('stops after a matching stop rule and leaves nonmatching stop rules inert', () => {
    const result = evaluateClassificationRules(
      [
        rule('not-matched', 30, 'provider.categoryId', 'eq', 'missing', [
          { type: 'STOP_PROCESSING' },
        ]),
        rule(
          'stop',
          20,
          'transaction.systemDirection',
          'eq',
          'OUTFLOW',
          [{ type: 'SET_SPEND_INCLUSION', inclusion: 'EXCLUDE' }],
          { stopProcessing: true },
        ),
        rule('never', 10, 'transaction.systemDirection', 'eq', 'OUTFLOW', [
          { type: 'SET_CATEGORY', categoryId: categoryA },
        ]),
      ],
      facts,
    );

    expect(result.stoppedByRuleId).toBe('stop');
    expect(result.matchedRules.map(({ ruleId }) => ruleId)).toEqual(['stop']);
    expect(result.actions.category).toBeNull();
    expect(result.actions.spendInclusion?.value).toBe('EXCLUDE');
  });

  it('keeps missing optional provider and merchant fields fail-closed', () => {
    const missing = {
      ...facts,
      merchant: { id: null, normalizedKey: null },
      provider: { categoryId: null },
    };
    const result = evaluateClassificationRules(
      [
        rule('provider', 2, 'provider.categoryId', 'neq', 'food', [
          { type: 'SET_CATEGORY', categoryId: categoryA },
        ]),
        rule('merchant', 1, 'merchant.normalizedKey', 'contains', 'casa', [
          { type: 'SET_MERCHANT', merchantId: merchantA },
        ]),
      ],
      missing,
    );
    expect(result.matchedRules).toEqual([]);
  });

  it('reports tag conflicts and keeps the higher-priority operation', () => {
    const result = evaluateClassificationRules(
      [
        rule('add', 2, 'transaction.systemDirection', 'eq', 'OUTFLOW', [
          { type: 'ADD_TAG', tagId: tagA },
        ]),
        rule('remove', 1, 'transaction.systemDirection', 'eq', 'OUTFLOW', [
          { type: 'REMOVE_TAG', tagId: tagA },
        ]),
      ],
      facts,
    );
    expect(result.actions.addedTags).toHaveLength(1);
    expect(result.actions.removedTags).toEqual([]);
    expect(result.conflicts[0]?.field).toBe(`tag:${tagA}`);
  });

  it('fails closed on invalid stored DSL', () => {
    expect(() =>
      evaluateClassificationRules(
        [
          rule('unsafe', 1, 'transaction.rawPayload', 'eq', 'secret', [
            { type: 'STOP_PROCESSING' },
          ]),
        ],
        facts,
      ),
    ).toThrow();
  });

  it('fails closed on duplicate IDs, invalid priorities, and invalid creation instants', () => {
    const valid = rule('duplicate', 1, 'transaction.systemDirection', 'eq', 'OUTFLOW', [
      { type: 'STOP_PROCESSING' },
    ]);
    expect(() => evaluateClassificationRules([valid, valid], facts)).toThrow(/unique/u);
    expect(() => evaluateClassificationRules([{ ...valid, priority: Number.NaN }], facts)).toThrow(
      /priority/u,
    );
    expect(() =>
      evaluateClassificationRules([{ ...valid, createdAt: 'not-an-instant' }], facts),
    ).toThrow(/createdAt/u);
  });
});
