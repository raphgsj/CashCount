import type { Pool, PoolClient } from 'pg';

import {
  classificationRuleActionsSchema,
  classificationRuleConditionsSchema,
  classificationRuleEvaluationPolicyVersion,
  evaluateClassificationRules,
  type ClassificationRuleActions,
  type ClassificationRuleConflict,
  type ClassificationRuleEvaluationResult,
  type ClassificationRuleFacts,
  type EvaluatableClassificationRule,
} from '@cashcount/classification';

import { canonicalJsonSha256 } from './encryption.js';

export type ClassificationRuleSource = 'IMPORT' | 'SYSTEM_SUGGESTION' | 'USER';

export interface CreateClassificationRuleInput {
  actions: unknown;
  actorId: string;
  conditions: unknown;
  name: string;
  priority: number;
  source: ClassificationRuleSource;
  stopProcessing?: boolean;
}

export interface ClassificationRuleRecord {
  actions: ClassificationRuleActions;
  conditions: ReturnType<typeof classificationRuleConditionsSchema.parse>;
  createdAt: Date;
  hitCount: string;
  id: string;
  isActive: boolean;
  name: string;
  priority: number;
  source: ClassificationRuleSource;
  stopProcessing: boolean;
  updatedAt: Date;
  workspaceId: string;
}

export interface PersistedRuleEvaluationResult {
  evaluation: ClassificationRuleEvaluationResult;
  inputFingerprint: string;
  newlyRecordedMatches: number;
  transactionId: string;
  workspaceId: string;
}

export interface ConfirmedClassificationRuleSuggestion {
  activated: boolean;
  rule: ClassificationRuleRecord;
}

interface RuleRow {
  actions: unknown;
  conditions: unknown;
  created_at: Date;
  hit_count: string;
  id: string;
  is_active: boolean;
  name: string;
  priority: number;
  source: ClassificationRuleSource;
  stop_processing: boolean;
  updated_at: Date;
  workspace_id: string;
}

interface TransactionFactsRow {
  account_currency: string;
  account_currency_amount_signed: string | null;
  account_type: string;
  description_normalized: string;
  financial_account_id: string;
  installment_total: number | null;
  merchant_id: string | null;
  merchant_normalized_key: string | null;
  provider_amount_signed: string;
  provider_category_id: string | null;
  provider_currency: string;
  provider_type: string | null;
  system_direction: string;
  system_financial_role: string;
  transaction_local_date: string;
}

export class ClassificationRuleInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ClassificationRuleInvariantError';
  }
}

export class ClassificationTransactionNotFoundError extends Error {
  public constructor() {
    super('Transaction was not found in the required workspace.');
    this.name = 'ClassificationTransactionNotFoundError';
  }
}

function requireText(name: string, value: string, maximum: number): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > maximum ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  ) {
    throw new TypeError(`${name} must contain 1 to ${maximum} trimmed characters.`);
  }
  return value;
}

function requirePriority(value: number): number {
  if (!Number.isInteger(value) || value < -1_000_000 || value > 1_000_000) {
    throw new TypeError('priority must be an integer between -1000000 and 1000000.');
  }
  return value;
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original failure when PostgreSQL already aborted the transaction.
  }
}

async function requireWorkspace(client: PoolClient, workspaceId: string): Promise<void> {
  const result = await client.query(`select 1 from workspace where id = $1`, [workspaceId]);
  if (result.rowCount !== 1) {
    throw new ClassificationRuleInvariantError('Classification workspace was not found.');
  }
}

async function requireActionReferences(
  client: PoolClient,
  workspaceId: string,
  actions: ClassificationRuleActions,
): Promise<void> {
  for (const action of actions.operations) {
    if (action.type === 'SET_CATEGORY') {
      const category = await client.query(
        `select 1 from category
         where id = $1 and is_active and (workspace_id is null or workspace_id = $2)`,
        [action.categoryId, workspaceId],
      );
      if (category.rowCount !== 1) {
        throw new ClassificationRuleInvariantError(
          'Rule category is not active and visible in the required workspace.',
        );
      }
    } else if (action.type === 'SET_MERCHANT') {
      const merchant = await client.query(
        `select 1 from merchant where workspace_id = $1 and id = $2`,
        [workspaceId, action.merchantId],
      );
      if (merchant.rowCount !== 1) {
        throw new ClassificationRuleInvariantError(
          'Rule merchant was not found in the required workspace.',
        );
      }
    } else if (action.type === 'ADD_TAG' || action.type === 'REMOVE_TAG') {
      const tag = await client.query(`select 1 from tag where workspace_id = $1 and id = $2`, [
        workspaceId,
        action.tagId,
      ]);
      if (tag.rowCount !== 1) {
        throw new ClassificationRuleInvariantError(
          'Rule tag was not found in the required workspace.',
        );
      }
    }
  }
}

function mapRule(row: RuleRow): ClassificationRuleRecord {
  return {
    actions: classificationRuleActionsSchema.parse(row.actions),
    conditions: classificationRuleConditionsSchema.parse(row.conditions),
    createdAt: row.created_at,
    hitCount: row.hit_count,
    id: row.id,
    isActive: row.is_active,
    name: row.name,
    priority: row.priority,
    source: row.source,
    stopProcessing: row.stop_processing,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

function facts(row: TransactionFactsRow): ClassificationRuleFacts {
  return {
    transaction: {
      accountCurrency: row.account_currency,
      accountCurrencyAmountSigned: row.account_currency_amount_signed,
      accountId: row.financial_account_id,
      accountType: row.account_type,
      descriptionNormalized: row.description_normalized,
      installmentTotal: row.installment_total,
      providerAmountSigned: row.provider_amount_signed,
      providerCurrency: row.provider_currency,
      providerType: row.provider_type,
      systemDirection: row.system_direction,
      systemFinancialRole: row.system_financial_role,
      transactionLocalDate: row.transaction_local_date,
    },
    merchant: { id: row.merchant_id, normalizedKey: row.merchant_normalized_key },
    provider: { categoryId: row.provider_category_id },
  };
}

function evaluatableRule(row: RuleRow): EvaluatableClassificationRule {
  return {
    actions: row.actions,
    conditions: row.conditions,
    createdAt: row.created_at,
    id: row.id,
    priority: row.priority,
    stopProcessing: row.stop_processing,
  };
}

function conflictCount(conflicts: readonly ClassificationRuleConflict[], ruleId: string): number {
  return conflicts.filter(
    ({ losingRuleId, winningRuleId }) => losingRuleId === ruleId || winningRuleId === ruleId,
  ).length;
}

export class ClassificationRuleRepository {
  public constructor(private readonly pool: Pool) {}

  public async createRule(
    workspaceId: string,
    input: CreateClassificationRuleInput,
  ): Promise<ClassificationRuleRecord> {
    requireText('workspaceId', workspaceId, 100);
    const name = requireText('name', input.name, 200);
    const actorId = requireText('actorId', input.actorId, 200);
    const priority = requirePriority(input.priority);
    const conditions = classificationRuleConditionsSchema.parse(input.conditions);
    const actions = classificationRuleActionsSchema.parse(input.actions);
    const stopProcessing = input.stopProcessing ?? true;
    const isActive = input.source !== 'SYSTEM_SUGGESTION';
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await requireWorkspace(client, workspaceId);
      await requireActionReferences(client, workspaceId, actions);
      const inserted = await client.query<RuleRow>(
        `insert into classification_rule (
           workspace_id, name, priority, conditions, actions, stop_processing, source, is_active
         ) values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
         returning id, workspace_id, name, priority, conditions, actions, stop_processing,
                   source, is_active, hit_count::text, created_at, updated_at`,
        [
          workspaceId,
          name,
          priority,
          JSON.stringify(conditions),
          JSON.stringify(actions),
          stopProcessing,
          input.source,
          isActive,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined)
        throw new ClassificationRuleInvariantError('Rule insert returned no row.');
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'CLASSIFICATION_RULE_CREATED', 'CLASSIFICATION_RULE', $3,
                   jsonb_build_object('source', $4::text, 'isActive', $5::boolean))`,
        [workspaceId, actorId, row.id, input.source, isActive],
      );
      await client.query('commit');
      return mapRule(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async confirmSuggestion(
    workspaceId: string,
    ruleId: string,
    actorId: string,
  ): Promise<ConfirmedClassificationRuleSuggestion> {
    requireText('workspaceId', workspaceId, 100);
    requireText('ruleId', ruleId, 100);
    requireText('actorId', actorId, 200);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const selected = await client.query<RuleRow>(
        `select id, workspace_id, name, priority, conditions, actions, stop_processing,
                source, is_active, hit_count::text, created_at, updated_at
         from classification_rule where workspace_id = $1 and id = $2 for update`,
        [workspaceId, ruleId],
      );
      const current = selected.rows[0];
      if (current === undefined || current.source !== 'SYSTEM_SUGGESTION') {
        throw new ClassificationRuleInvariantError(
          'Classification rule suggestion was not found in the required workspace.',
        );
      }
      const parsedActions = classificationRuleActionsSchema.parse(current.actions);
      classificationRuleConditionsSchema.parse(current.conditions);
      await requireActionReferences(client, workspaceId, parsedActions);
      if (current.is_active) {
        await client.query('commit');
        return { activated: false, rule: mapRule(current) };
      }

      const activated = await client.query<RuleRow>(
        `update classification_rule
         set is_active = true, updated_at = now()
         where workspace_id = $1 and id = $2 and source = 'SYSTEM_SUGGESTION' and not is_active
         returning id, workspace_id, name, priority, conditions, actions, stop_processing,
                   source, is_active, hit_count::text, created_at, updated_at`,
        [workspaceId, ruleId],
      );
      const row = activated.rows[0];
      if (row === undefined) {
        throw new ClassificationRuleInvariantError('Rule suggestion activation returned no row.');
      }
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'CLASSIFICATION_RULE_SUGGESTION_CONFIRMED',
                   'CLASSIFICATION_RULE', $3, '{}'::jsonb)`,
        [workspaceId, actorId, ruleId],
      );
      await client.query('commit');
      return { activated: true, rule: mapRule(row) };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async evaluateTransaction(
    workspaceId: string,
    transactionId: string,
  ): Promise<PersistedRuleEvaluationResult> {
    requireText('workspaceId', workspaceId, 100);
    requireText('transactionId', transactionId, 100);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const transaction = await client.query<TransactionFactsRow>(
        `select ft.financial_account_id, fa.account_type, ft.description_normalized,
                ft.system_direction, ft.system_financial_role, ft.provider_type,
                ft.provider_amount_signed::text, ft.provider_currency,
                ft.account_currency_amount_signed::text, ft.account_currency,
                ft.transaction_local_date::text, ft.installment_total,
                ft.system_merchant_id as merchant_id, m.normalized_key as merchant_normalized_key,
                ft.provider_category_id
         from financial_transaction ft
         join financial_account fa
           on fa.workspace_id = ft.workspace_id and fa.id = ft.financial_account_id
         left join merchant m
           on m.workspace_id = ft.workspace_id and m.id = ft.system_merchant_id
         where ft.workspace_id = $1 and ft.id = $2 and ft.deleted_at is null
         for update of ft`,
        [workspaceId, transactionId],
      );
      const transactionRow = transaction.rows[0];
      if (transactionRow === undefined) throw new ClassificationTransactionNotFoundError();

      const activeRules = await client.query<RuleRow>(
        `select id, workspace_id, name, priority, conditions, actions, stop_processing,
                source, is_active, hit_count::text, created_at, updated_at
         from classification_rule
         where workspace_id = $1 and is_active
         order by priority desc, created_at, id
         for share`,
        [workspaceId],
      );
      for (const rule of activeRules.rows) {
        classificationRuleConditionsSchema.parse(rule.conditions);
        const actions = classificationRuleActionsSchema.parse(rule.actions);
        await requireActionReferences(client, workspaceId, actions);
      }

      const evaluationFacts = facts(transactionRow);
      const inputFingerprint = canonicalJsonSha256({
        // Rule-produced merchant/role values are deliberately excluded: applying a rule must not
        // make its own retry look like a new logical provider-fact evaluation.
        facts: {
          provider: evaluationFacts.provider,
          transaction: {
            accountCurrency: evaluationFacts.transaction.accountCurrency,
            accountCurrencyAmountSigned: evaluationFacts.transaction.accountCurrencyAmountSigned,
            accountId: evaluationFacts.transaction.accountId,
            accountType: evaluationFacts.transaction.accountType,
            descriptionNormalized: evaluationFacts.transaction.descriptionNormalized,
            installmentTotal: evaluationFacts.transaction.installmentTotal,
            providerAmountSigned: evaluationFacts.transaction.providerAmountSigned,
            providerCurrency: evaluationFacts.transaction.providerCurrency,
            providerType: evaluationFacts.transaction.providerType,
            systemDirection: evaluationFacts.transaction.systemDirection,
            transactionLocalDate: evaluationFacts.transaction.transactionLocalDate,
          },
        },
        policyVersion: classificationRuleEvaluationPolicyVersion,
        rules: activeRules.rows.map((rule) => ({
          actions: rule.actions,
          conditions: rule.conditions,
          createdAt: rule.created_at.toISOString(),
          id: rule.id,
          priority: rule.priority,
          stopProcessing: rule.stop_processing,
          updatedAt: rule.updated_at.toISOString(),
        })),
      });
      const evaluation = evaluateClassificationRules(
        activeRules.rows.map(evaluatableRule),
        evaluationFacts,
      );
      const ruleById = new Map(activeRules.rows.map((rule) => [rule.id, rule]));
      let newlyRecordedMatches = 0;

      for (const matched of evaluation.matchedRules) {
        const rule = ruleById.get(matched.ruleId);
        if (rule === undefined)
          throw new ClassificationRuleInvariantError('Matched rule was not loaded.');
        const parsedActions = classificationRuleActionsSchema.parse(rule.actions);
        const actionNames = parsedActions.operations.map(({ type }) => type).join(',');
        const categoryId =
          evaluation.actions.category?.ruleId === rule.id
            ? evaluation.actions.category.value
            : null;
        const merchantId =
          evaluation.actions.merchant?.ruleId === rule.id
            ? evaluation.actions.merchant.value
            : null;
        const financialRole =
          evaluation.actions.financialRole?.ruleId === rule.id
            ? evaluation.actions.financialRole.value
            : null;
        const decision = await client.query(
          `insert into classification_decision (
             workspace_id, financial_transaction_id, source, source_reference,
             classification_rule_id, category_id, merchant_id, financial_role, confidence,
             input_fingerprint, rationale, selected
           ) values ($1, $2, 'RULE', $3::text, $3::uuid, $4, $5, $6, '1.0000', $7, $8, $9)
           on conflict (workspace_id, financial_transaction_id, source, source_reference,
                        input_fingerprint) do nothing
           returning id`,
          [
            workspaceId,
            transactionId,
            rule.id,
            categoryId,
            merchantId,
            financialRole,
            inputFingerprint,
            `policy=${classificationRuleEvaluationPolicyVersion};actions=${actionNames};conflicts=${conflictCount(evaluation.conflicts, rule.id)}`,
            matched.contributed,
          ],
        );
        if (decision.rowCount === 1) {
          newlyRecordedMatches += 1;
          await client.query(
            `update classification_rule
             set hit_count = hit_count + 1, last_hit_at = now(), updated_at = updated_at
             where workspace_id = $1 and id = $2`,
            [workspaceId, rule.id],
          );
        }
      }

      const hasSystemUpdate =
        evaluation.actions.category !== null ||
        evaluation.actions.merchant !== null ||
        evaluation.actions.financialRole !== null ||
        evaluation.actions.spendInclusion !== null;
      if (hasSystemUpdate) {
        await client.query(
          `update financial_transaction
           set system_category_id = case when $3::boolean then $4::uuid else system_category_id end,
               system_category_source = case when $3::boolean then 'RULE' else system_category_source end,
               system_category_confidence = case when $3::boolean then 1 else system_category_confidence end,
               system_merchant_id = case when $5::boolean then $6::uuid else system_merchant_id end,
               system_merchant_source = case when $5::boolean then 'RULE' else system_merchant_source end,
               system_merchant_confidence = case when $5::boolean then 1 else system_merchant_confidence end,
               system_financial_role = case when $7::boolean then $8::text else system_financial_role end,
               system_financial_role_source = case when $7::boolean then 'RULE' else system_financial_role_source end,
               system_financial_role_confidence = case when $7::boolean then 1 else system_financial_role_confidence end,
               system_is_excluded_from_spend = case when $9::boolean then $10::text = 'EXCLUDE' else system_is_excluded_from_spend end,
               system_exclusion_source = case when $9::boolean then 'RULE' else system_exclusion_source end,
               updated_at = now()
           where workspace_id = $1 and id = $2`,
          [
            workspaceId,
            transactionId,
            evaluation.actions.category !== null,
            evaluation.actions.category?.value ?? null,
            evaluation.actions.merchant !== null,
            evaluation.actions.merchant?.value ?? null,
            evaluation.actions.financialRole !== null,
            evaluation.actions.financialRole?.value ?? null,
            evaluation.actions.spendInclusion !== null,
            evaluation.actions.spendInclusion?.value ?? null,
          ],
        );
      }

      for (const { value: tagId } of evaluation.actions.addedTags) {
        await client.query(
          `insert into transaction_tag (workspace_id, financial_transaction_id, tag_id)
           values ($1, $2, $3) on conflict do nothing`,
          [workspaceId, transactionId, tagId],
        );
      }
      for (const { value: tagId } of evaluation.actions.removedTags) {
        await client.query(
          `delete from transaction_tag
           where workspace_id = $1 and financial_transaction_id = $2 and tag_id = $3`,
          [workspaceId, transactionId, tagId],
        );
      }

      await client.query('commit');
      return {
        evaluation,
        inputFingerprint,
        newlyRecordedMatches,
        transactionId,
        workspaceId,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
