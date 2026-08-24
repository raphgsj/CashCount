import {
  classificationRuleActionsSchema,
  classificationRuleConditionsSchema,
  testSafeRulePattern,
  type ClassificationRuleConditionNode,
  type ClassificationRuleField,
  type ClassificationRulePredicate,
} from './rule-dsl.js';

export const classificationRuleEvaluationPolicyVersion = 'rule-evaluation-v1' as const;

export interface ClassificationRuleFacts {
  merchant: {
    id: string | null;
    normalizedKey: string | null;
  };
  provider: {
    categoryId: string | null;
  };
  transaction: {
    accountCurrency: string;
    accountCurrencyAmountSigned: string | null;
    accountId: string;
    accountType: string;
    descriptionNormalized: string;
    installmentTotal: number | null;
    providerAmountSigned: string;
    providerCurrency: string;
    providerType: string | null;
    systemDirection: string;
    systemFinancialRole: string;
    transactionLocalDate: string;
  };
}

export interface EvaluatableClassificationRule {
  actions: unknown;
  conditions: unknown;
  createdAt: Date | string;
  id: string;
  priority: number;
  stopProcessing: boolean;
}

export type ClassificationRuleConflictField =
  | 'categoryId'
  | 'financialRole'
  | 'merchantId'
  | 'recurringCandidate'
  | 'spendInclusion'
  | `tag:${string}`;

export interface ClassificationRuleConflict {
  field: ClassificationRuleConflictField;
  losingRuleId: string;
  losingValue: string;
  winningRuleId: string;
  winningValue: string;
}

export interface AppliedRuleValue<T> {
  ruleId: string;
  value: T;
}

export interface AppliedClassificationRuleActions {
  addedTags: readonly AppliedRuleValue<string>[];
  category: AppliedRuleValue<string> | null;
  financialRole: AppliedRuleValue<string> | null;
  merchant: AppliedRuleValue<string> | null;
  recurringCandidate: AppliedRuleValue<true> | null;
  removedTags: readonly AppliedRuleValue<string>[];
  spendInclusion: AppliedRuleValue<'EXCLUDE' | 'INCLUDE'> | null;
}

export interface MatchedClassificationRule {
  contributed: boolean;
  ruleId: string;
  stoppedProcessing: boolean;
}

export interface ClassificationRuleEvaluationResult {
  actions: AppliedClassificationRuleActions;
  conflicts: readonly ClassificationRuleConflict[];
  matchedRules: readonly MatchedClassificationRule[];
  policyVersion: typeof classificationRuleEvaluationPolicyVersion;
  stoppedByRuleId: string | null;
}

function actualValue(facts: ClassificationRuleFacts, field: ClassificationRuleField): unknown {
  switch (field) {
    case 'transaction.descriptionNormalized':
      return facts.transaction.descriptionNormalized;
    case 'transaction.systemDirection':
      return facts.transaction.systemDirection;
    case 'transaction.systemFinancialRole':
      return facts.transaction.systemFinancialRole;
    case 'transaction.providerType':
      return facts.transaction.providerType;
    case 'transaction.providerAmountSigned':
      return facts.transaction.providerAmountSigned;
    case 'transaction.providerCurrency':
      return facts.transaction.providerCurrency;
    case 'transaction.accountCurrencyAmountSigned':
      return facts.transaction.accountCurrencyAmountSigned;
    case 'transaction.accountCurrency':
      return facts.transaction.accountCurrency;
    case 'transaction.accountId':
      return facts.transaction.accountId;
    case 'transaction.accountType':
      return facts.transaction.accountType;
    case 'transaction.transactionLocalDate':
      return facts.transaction.transactionLocalDate;
    case 'transaction.installmentTotal':
      return facts.transaction.installmentTotal;
    case 'merchant.id':
      return facts.merchant.id;
    case 'merchant.normalizedKey':
      return facts.merchant.normalizedKey;
    case 'provider.categoryId':
      return facts.provider.categoryId;
  }
}

const decimalFields: ReadonlySet<ClassificationRuleField> = new Set([
  'transaction.providerAmountSigned',
  'transaction.accountCurrencyAmountSigned',
]);

function decimalUnits(value: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const units = BigInt(integer) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  return negative ? -units : units;
}

function compare(field: ClassificationRuleField, left: unknown, right: unknown): number {
  if (decimalFields.has(field)) {
    const difference = decimalUnits(left as string) - decimalUnits(right as string);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const leftText = left as string;
  const rightText = right as string;
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}

function evaluatePredicate(
  predicate: ClassificationRulePredicate,
  facts: ClassificationRuleFacts,
): boolean {
  const actual = actualValue(facts, predicate.field);
  if (actual === null || actual === undefined) {
    return false;
  }

  switch (predicate.operator) {
    case 'eq':
      return compare(predicate.field, actual, predicate.value) === 0;
    case 'neq':
      return compare(predicate.field, actual, predicate.value) !== 0;
    case 'contains':
      return (actual as string).includes(predicate.value as string);
    case 'starts_with':
      return (actual as string).startsWith(predicate.value as string);
    case 'in':
      return (predicate.value as unknown[]).some(
        (candidate) => compare(predicate.field, actual, candidate) === 0,
      );
    case 'between': {
      const [minimum, maximum] = predicate.value as [unknown, unknown];
      return (
        compare(predicate.field, actual, minimum) >= 0 &&
        compare(predicate.field, actual, maximum) <= 0
      );
    }
    case 'gt':
      return compare(predicate.field, actual, predicate.value) > 0;
    case 'gte':
      return compare(predicate.field, actual, predicate.value) >= 0;
    case 'lt':
      return compare(predicate.field, actual, predicate.value) < 0;
    case 'lte':
      return compare(predicate.field, actual, predicate.value) <= 0;
    case 'regex_safe':
      return testSafeRulePattern(predicate.value as string, actual as string);
  }
}

function evaluateNode(
  node: ClassificationRuleConditionNode,
  facts: ClassificationRuleFacts,
): boolean {
  if (node.type === 'PREDICATE') {
    return evaluatePredicate(node, facts);
  }
  return node.combinator === 'ALL'
    ? node.conditions.every((child) => evaluateNode(child, facts))
    : node.conditions.some((child) => evaluateNode(child, facts));
}

function createdAtMillis(value: Date | string): number {
  const milliseconds = value instanceof Date ? value.valueOf() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError('Rule createdAt must be a valid instant.');
  }
  return milliseconds;
}

function orderedRules(
  rules: readonly EvaluatableClassificationRule[],
): EvaluatableClassificationRule[] {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.id.length === 0 || ids.has(rule.id)) {
      throw new TypeError('Rule IDs must be non-empty and unique.');
    }
    ids.add(rule.id);
    if (
      !Number.isSafeInteger(rule.priority) ||
      rule.priority < -2_147_483_648 ||
      rule.priority > 2_147_483_647
    ) {
      throw new TypeError('Rule priority must be a PostgreSQL integer.');
    }
    createdAtMillis(rule.createdAt);
  }
  return [...rules].sort((left, right) => {
    const priority = right.priority - left.priority;
    if (priority !== 0) return priority;
    const created = createdAtMillis(left.createdAt) - createdAtMillis(right.createdAt);
    if (created !== 0) return created;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

function conflictValue(value: boolean | string): string {
  return typeof value === 'boolean' ? String(value) : value;
}

export function evaluateClassificationRules(
  rules: readonly EvaluatableClassificationRule[],
  facts: ClassificationRuleFacts,
): ClassificationRuleEvaluationResult {
  const actions: {
    addedTags: Map<string, AppliedRuleValue<string>>;
    category: AppliedRuleValue<string> | null;
    financialRole: AppliedRuleValue<string> | null;
    merchant: AppliedRuleValue<string> | null;
    recurringCandidate: AppliedRuleValue<true> | null;
    removedTags: Map<string, AppliedRuleValue<string>>;
    spendInclusion: AppliedRuleValue<'EXCLUDE' | 'INCLUDE'> | null;
  } = {
    addedTags: new Map(),
    category: null,
    financialRole: null,
    merchant: null,
    recurringCandidate: null,
    removedTags: new Map(),
    spendInclusion: null,
  };
  const conflicts: ClassificationRuleConflict[] = [];
  const matchedRules: MatchedClassificationRule[] = [];
  let stoppedByRuleId: string | null = null;

  const applySingleton = <T extends boolean | string>(
    field: Exclude<ClassificationRuleConflictField, `tag:${string}`>,
    current: AppliedRuleValue<T> | null,
    next: T,
    ruleId: string,
  ): { contributed: boolean; value: AppliedRuleValue<T> } => {
    if (current === null) return { contributed: true, value: { ruleId, value: next } };
    if (current.value !== next) {
      conflicts.push({
        field,
        losingRuleId: ruleId,
        losingValue: conflictValue(next),
        winningRuleId: current.ruleId,
        winningValue: conflictValue(current.value),
      });
    }
    return { contributed: false, value: current };
  };

  for (const rule of orderedRules(rules)) {
    const conditions = classificationRuleConditionsSchema.parse(rule.conditions);
    const ruleActions = classificationRuleActionsSchema.parse(rule.actions);
    if (!evaluateNode(conditions.root, facts)) continue;

    let contributed = false;
    let actionStops = false;
    for (const action of ruleActions.operations) {
      switch (action.type) {
        case 'SET_CATEGORY': {
          const result = applySingleton('categoryId', actions.category, action.categoryId, rule.id);
          actions.category = result.value;
          contributed ||= result.contributed;
          break;
        }
        case 'SET_MERCHANT': {
          const result = applySingleton('merchantId', actions.merchant, action.merchantId, rule.id);
          actions.merchant = result.value;
          contributed ||= result.contributed;
          break;
        }
        case 'SET_FINANCIAL_ROLE': {
          const result = applySingleton(
            'financialRole',
            actions.financialRole,
            action.financialRole,
            rule.id,
          );
          actions.financialRole = result.value;
          contributed ||= result.contributed;
          break;
        }
        case 'SET_SPEND_INCLUSION': {
          const result = applySingleton(
            'spendInclusion',
            actions.spendInclusion,
            action.inclusion,
            rule.id,
          );
          actions.spendInclusion = result.value;
          contributed ||= result.contributed;
          break;
        }
        case 'ADD_TAG':
        case 'REMOVE_TAG': {
          const adding = action.type === 'ADD_TAG';
          const own = adding ? actions.addedTags : actions.removedTags;
          const opposite = adding ? actions.removedTags : actions.addedTags;
          const existingOpposite = opposite.get(action.tagId);
          if (existingOpposite !== undefined) {
            conflicts.push({
              field: `tag:${action.tagId}`,
              losingRuleId: rule.id,
              losingValue: adding ? 'ADD' : 'REMOVE',
              winningRuleId: existingOpposite.ruleId,
              winningValue: adding ? 'REMOVE' : 'ADD',
            });
          } else if (!own.has(action.tagId)) {
            own.set(action.tagId, { ruleId: rule.id, value: action.tagId });
            contributed = true;
          }
          break;
        }
        case 'MARK_RECURRING_CANDIDATE': {
          const result = applySingleton(
            'recurringCandidate',
            actions.recurringCandidate,
            true,
            rule.id,
          );
          actions.recurringCandidate = result.value;
          contributed ||= result.contributed;
          break;
        }
        case 'STOP_PROCESSING':
          actionStops = true;
          contributed = true;
          break;
      }
    }

    const stoppedProcessing = rule.stopProcessing || actionStops;
    matchedRules.push({ contributed, ruleId: rule.id, stoppedProcessing });
    if (stoppedProcessing) {
      stoppedByRuleId = rule.id;
      break;
    }
  }

  return {
    actions: {
      addedTags: [...actions.addedTags.values()],
      category: actions.category,
      financialRole: actions.financialRole,
      merchant: actions.merchant,
      recurringCandidate: actions.recurringCandidate,
      removedTags: [...actions.removedTags.values()],
      spendInclusion: actions.spendInclusion,
    },
    conflicts,
    matchedRules,
    policyVersion: classificationRuleEvaluationPolicyVersion,
    stoppedByRuleId,
  };
}
