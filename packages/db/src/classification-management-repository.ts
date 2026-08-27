import type { Pool, PoolClient } from 'pg';

import {
  classificationRuleActionsSchema,
  classificationRuleConditionsSchema,
  classificationRuleEvaluationPolicyVersion,
  evaluateClassificationRules,
  normalizeTransactionDescription,
  type ClassificationRuleActions,
  type ClassificationRuleConditions,
  type ClassificationRuleFacts,
} from '@cashcount/classification';

import {
  ClassificationRuleInvariantError,
  ClassificationRuleRepository,
  type ClassificationRuleRecord,
} from './classification-rule-repository.js';

export type ManagedCategoryKind = 'EXPENSE' | 'INCOME' | 'OTHER' | 'TRANSFER';
export type ManagedMerchantReviewStatus = 'AUTO' | 'CONFIRMED' | 'NEEDS_REVIEW';
export type ManagedClassificationRuleRecord = ClassificationRuleRecord;

export interface ManagedCategoryRecord {
  code: string;
  iconKey: null | string;
  id: string;
  isActive: boolean;
  kind: ManagedCategoryKind;
  nameEn: string;
  namePtBr: string;
  parentId: null | string;
  scope: 'BUILT_IN' | 'WORKSPACE';
  sortOrder: number;
}

export interface CreateManagedCategoryInput {
  actorId: string;
  iconKey?: null | string;
  kind: ManagedCategoryKind;
  nameEn: string;
  namePtBr: string;
  parentId?: null | string;
  sortOrder?: number;
}

export interface UpdateManagedCategoryInput {
  actorId: string;
  iconKey?: null | string;
  isActive?: boolean;
  kind?: ManagedCategoryKind;
  nameEn?: string;
  namePtBr?: string;
  parentId?: null | string;
  sortOrder?: number;
}

export interface ManagedMerchantAliasRecord {
  alias: string;
  confidence: string;
  id: string;
  isActive: boolean;
  isConfirmed: boolean;
  matchType: 'CONTAINS' | 'EXACT' | 'PREFIX' | 'REGEX';
  source: 'HEURISTIC' | 'IMPORT' | 'PROVIDER' | 'USER';
}

export interface ManagedMerchantRecord {
  aliases: ManagedMerchantAliasRecord[];
  canonicalName: string;
  defaultCategoryId: null | string;
  id: string;
  mcc: null | string;
  merchantGroup: null | string;
  reviewStatus: ManagedMerchantReviewStatus;
}

export interface UpdateManagedMerchantInput {
  actorId: string;
  canonicalName?: string;
  defaultCategoryId?: null | string;
  mcc?: null | string;
  merchantGroup?: null | string;
  reviewStatus?: ManagedMerchantReviewStatus;
}

export interface UpdateManagedRuleInput {
  actions?: unknown;
  actorId: string;
  conditions?: unknown;
  isActive?: boolean;
  name?: string;
  priority?: number;
  stopProcessing?: boolean;
}

export interface ManagedRulePreviewMatch {
  description: string;
  localDate: string;
  transactionId: string;
  wouldStopProcessing: boolean;
}

export interface ManagedRulePreviewResult {
  matches: ManagedRulePreviewMatch[];
  policyVersion: typeof classificationRuleEvaluationPolicyVersion;
  scannedCount: number;
  truncated: boolean;
}

interface CategoryRow {
  code: string;
  icon_key: null | string;
  id: string;
  is_active: boolean;
  kind: ManagedCategoryKind;
  name_en: string;
  name_pt_br: string;
  parent_id: null | string;
  sort_order: number;
  workspace_id: null | string;
}

interface MerchantRow {
  aliases: ManagedMerchantAliasRecord[];
  canonical_name: string;
  cnpj_hash: null | string;
  default_category_id: null | string;
  id: string;
  mcc: null | string;
  merchant_group: null | string;
  normalized_key: string;
  review_status: ManagedMerchantReviewStatus;
  workspace_id: string;
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
  source: 'IMPORT' | 'SYSTEM_SUGGESTION' | 'USER';
  stop_processing: boolean;
  updated_at: Date;
  workspace_id: string;
}

interface PreviewRow {
  account_currency: string;
  account_currency_amount_signed: null | string;
  account_type: string;
  description_normalized: string;
  financial_account_id: string;
  id: string;
  installment_total: null | number;
  local_date: string;
  merchant_id: null | string;
  merchant_normalized_key: null | string;
  provider_amount_signed: string;
  provider_category_id: null | string;
  provider_currency: string;
  provider_type: null | string;
  system_direction: string;
  system_financial_role: string;
}

export class ClassificationManagementInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ClassificationManagementInvariantError';
  }
}

export class ClassificationManagementNotFoundError extends Error {
  public readonly entity: 'category' | 'merchant' | 'rule';

  public constructor(entity: 'category' | 'merchant' | 'rule') {
    super(`${entity} was not found in the required workspace.`);
    this.name = 'ClassificationManagementNotFoundError';
    this.entity = entity;
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

function optionalText(name: string, value: null | string | undefined, maximum: number) {
  return value === null || value === undefined ? value : requireText(name, value, maximum);
}

function requirePriority(value: number): number {
  if (!Number.isInteger(value) || value < -1_000_000 || value > 1_000_000) {
    throw new TypeError('priority must be an integer between -1000000 and 1000000.');
  }
  return value;
}

function requireSortOrder(value: number): number {
  if (!Number.isInteger(value) || value < -1_000_000 || value > 1_000_000) {
    throw new TypeError('sortOrder must be an integer between -1000000 and 1000000.');
  }
  return value;
}

function requireMcc(value: null | string | undefined): null | string | undefined {
  if (value !== null && value !== undefined && !/^\d{4}$/u.test(value)) {
    throw new TypeError('mcc must contain exactly four digits.');
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

function category(row: CategoryRow): ManagedCategoryRecord {
  return {
    code: row.code,
    iconKey: row.icon_key,
    id: row.id,
    isActive: row.is_active,
    kind: row.kind,
    nameEn: row.name_en,
    namePtBr: row.name_pt_br,
    parentId: row.parent_id,
    scope: row.workspace_id === null ? 'BUILT_IN' : 'WORKSPACE',
    sortOrder: row.sort_order,
  };
}

function merchant(row: MerchantRow): ManagedMerchantRecord {
  return {
    aliases: row.aliases,
    canonicalName: row.canonical_name,
    defaultCategoryId: row.default_category_id,
    id: row.id,
    mcc: row.mcc,
    merchantGroup: row.merchant_group,
    reviewStatus: row.review_status,
  };
}

function rule(row: RuleRow): ClassificationRuleRecord {
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

function previewFacts(row: PreviewRow): ClassificationRuleFacts {
  return {
    merchant: { id: row.merchant_id, normalizedKey: row.merchant_normalized_key },
    provider: { categoryId: row.provider_category_id },
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
      transactionLocalDate: row.local_date,
    },
  };
}

const selectCategory = `select id, workspace_id, code, parent_id, kind, name_en, name_pt_br,
  icon_key, sort_order, is_active from category`;
const selectMerchant = `select
  merchant.id, merchant.workspace_id, merchant.canonical_name, merchant.normalized_key,
  merchant.merchant_group, merchant.mcc, merchant.cnpj_hash, merchant.default_category_id,
  merchant.review_status,
  coalesce(aliases.items, '[]'::jsonb) as aliases
from merchant
left join lateral (
  select jsonb_agg(jsonb_build_object(
    'alias', merchant_alias.alias_normalized,
    'confidence', merchant_alias.confidence::text,
    'id', merchant_alias.id,
    'isActive', merchant_alias.is_active,
    'isConfirmed', merchant_alias.is_confirmed,
    'matchType', merchant_alias.match_type,
    'source', merchant_alias.source
  ) order by merchant_alias.alias_normalized, merchant_alias.id) as items
  from merchant_alias
  where merchant_alias.workspace_id = merchant.workspace_id
    and merchant_alias.merchant_id = merchant.id
) aliases on true`;
const selectRule = `select id, workspace_id, name, priority, conditions, actions, stop_processing,
  source, is_active, hit_count::text, created_at, updated_at from classification_rule`;

async function requireVisibleCategory(
  client: PoolClient,
  workspaceId: string,
  categoryId: null | string,
): Promise<void> {
  if (categoryId === null) return;
  const result = await client.query(
    `select 1 from category
     where id = $1 and is_active and (workspace_id is null or workspace_id = $2)`,
    [categoryId, workspaceId],
  );
  if (result.rowCount !== 1) {
    throw new ClassificationManagementInvariantError(
      'Category is not active and visible in the required workspace.',
    );
  }
}

async function requireRuleActionReferences(
  client: PoolClient,
  workspaceId: string,
  actions: ClassificationRuleActions,
): Promise<void> {
  for (const action of actions.operations) {
    if (action.type === 'SET_CATEGORY') {
      await requireVisibleCategory(client, workspaceId, action.categoryId);
    } else if (action.type === 'SET_MERCHANT') {
      const result = await client.query(
        `select 1 from merchant where workspace_id = $1 and id = $2`,
        [workspaceId, action.merchantId],
      );
      if (result.rowCount !== 1) {
        throw new ClassificationManagementInvariantError(
          'Rule merchant is not visible in the required workspace.',
        );
      }
    } else if (action.type === 'ADD_TAG' || action.type === 'REMOVE_TAG') {
      const result = await client.query(`select 1 from tag where workspace_id = $1 and id = $2`, [
        workspaceId,
        action.tagId,
      ]);
      if (result.rowCount !== 1) {
        throw new ClassificationManagementInvariantError(
          'Rule tag is not visible in the required workspace.',
        );
      }
    }
  }
}

function replaceMerchantPredicateValue(
  value: unknown,
  sourceId: string,
  targetId: string,
): unknown {
  if (typeof value === 'string') return value === sourceId ? targetId : value;
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' && item === sourceId ? targetId : item));
  }
  return value;
}

function replaceMerchantReferences(value: unknown, sourceId: string, targetId: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => replaceMerchantReferences(item, sourceId, targetId));
  }
  if (value === null || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  const replaced = Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      key === 'merchantId' && item === sourceId
        ? targetId
        : replaceMerchantReferences(item, sourceId, targetId),
    ]),
  );
  if (object['type'] === 'PREDICATE' && object['field'] === 'merchant.id') {
    replaced['value'] = replaceMerchantPredicateValue(object['value'], sourceId, targetId);
  }
  return replaced;
}

export class ClassificationManagementRepository {
  public constructor(private readonly pool: Pool) {}

  public async listCategories(workspaceId: string, limit = 100): Promise<ManagedCategoryRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Category limit must be an integer from 1 to 100.');
    }
    const result = await this.pool.query<CategoryRow>(
      `${selectCategory}
       where workspace_id is null or workspace_id = $1
       order by sort_order, name_pt_br, id limit $2`,
      [workspaceId, limit],
    );
    return result.rows.map(category);
  }

  public async createCategory(
    workspaceId: string,
    input: CreateManagedCategoryInput,
  ): Promise<ManagedCategoryRecord> {
    const actorId = requireText('actorId', input.actorId, 200);
    const nameEn = requireText('nameEn', input.nameEn, 200);
    const namePtBr = requireText('namePtBr', input.namePtBr, 200);
    const iconKey = optionalText('iconKey', input.iconKey, 100) ?? null;
    const sortOrder = requireSortOrder(input.sortOrder ?? 0);
    const parentId = input.parentId ?? null;
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await requireVisibleCategory(client, workspaceId, parentId);
      const inserted = await client.query<CategoryRow>(
        `with identity as (select gen_random_uuid() as id)
         insert into category (
           id, workspace_id, code, parent_id, kind, name_en, name_pt_br, icon_key, sort_order
         ) select id, $1, 'custom.' || id::text, $2, $3, $4, $5, $6, $7 from identity
         returning id, workspace_id, code, parent_id, kind, name_en, name_pt_br,
                   icon_key, sort_order, is_active`,
        [workspaceId, parentId, input.kind, nameEn, namePtBr, iconKey, sortOrder],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw new ClassificationManagementInvariantError('Category insert returned no row.');
      }
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'CATEGORY_CREATED', 'CATEGORY', $3,
                   jsonb_build_object('kind', $4::text))`,
        [workspaceId, actorId, row.id, input.kind],
      );
      await client.query('commit');
      return category(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async updateCategory(
    workspaceId: string,
    categoryId: string,
    input: UpdateManagedCategoryInput,
  ): Promise<ManagedCategoryRecord> {
    const actorId = requireText('actorId', input.actorId, 200);
    const nameEn = optionalText('nameEn', input.nameEn, 200);
    const namePtBr = optionalText('namePtBr', input.namePtBr, 200);
    const iconKey = optionalText('iconKey', input.iconKey, 100);
    const sortOrder = input.sortOrder === undefined ? undefined : requireSortOrder(input.sortOrder);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const current = await client.query<CategoryRow>(
        `${selectCategory} where workspace_id = $1 and id = $2 for update`,
        [workspaceId, categoryId],
      );
      if (current.rows[0] === undefined)
        throw new ClassificationManagementNotFoundError('category');
      if (input.parentId !== undefined) {
        if (input.parentId === categoryId) {
          throw new ClassificationManagementInvariantError('Category cannot parent itself.');
        }
        await requireVisibleCategory(client, workspaceId, input.parentId);
        if (input.parentId !== null) {
          const cycle = await client.query(
            `with recursive ancestors(id, parent_id) as (
               select id, parent_id from category where id = $1
               union all
               select parent.id, parent.parent_id
               from category parent join ancestors child on parent.id = child.parent_id
             ) select 1 from ancestors where id = $2 limit 1`,
            [input.parentId, categoryId],
          );
          if (cycle.rowCount === 1) {
            throw new ClassificationManagementInvariantError(
              'Category parent would create a cycle.',
            );
          }
        }
      }
      if (input.isActive === false) {
        const references = await client.query(
          `select 1
           where exists (
             select 1 from category child
             where child.parent_id = $2 and child.is_active
           ) or exists (
             select 1 from merchant
             where workspace_id = $1 and default_category_id = $2
           ) or exists (
             select 1 from classification_rule
             where workspace_id = $1 and is_active
               and actions @> jsonb_build_object(
                 'operations', jsonb_build_array(
                   jsonb_build_object('type', 'SET_CATEGORY', 'categoryId', $2::text)
                 )
               )
           )`,
          [workspaceId, categoryId],
        );
        if (references.rowCount === 1) {
          throw new ClassificationManagementInvariantError(
            'Active category references must be removed before deactivation.',
          );
        }
      }
      const updated = await client.query<CategoryRow>(
        `update category set
           parent_id = case when $3::boolean then $4::uuid else parent_id end,
           kind = coalesce($5::text, kind),
           name_en = coalesce($6::text, name_en),
           name_pt_br = coalesce($7::text, name_pt_br),
           icon_key = case when $8::boolean then $9::text else icon_key end,
           sort_order = coalesce($10::integer, sort_order),
           is_active = coalesce($11::boolean, is_active),
           updated_at = now()
         where workspace_id = $1 and id = $2
         returning id, workspace_id, code, parent_id, kind, name_en, name_pt_br,
                   icon_key, sort_order, is_active`,
        [
          workspaceId,
          categoryId,
          input.parentId !== undefined,
          input.parentId ?? null,
          input.kind ?? null,
          nameEn ?? null,
          namePtBr ?? null,
          input.iconKey !== undefined,
          iconKey ?? null,
          sortOrder ?? null,
          input.isActive ?? null,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new ClassificationManagementNotFoundError('category');
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'CATEGORY_UPDATED', 'CATEGORY', $3,
                   jsonb_build_object('fields', $4::text[]))`,
        [workspaceId, actorId, categoryId, Object.keys(input).filter((key) => key !== 'actorId')],
      );
      await client.query('commit');
      return category(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async listMerchants(workspaceId: string, limit = 100): Promise<ManagedMerchantRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Merchant limit must be an integer from 1 to 100.');
    }
    const result = await this.pool.query<MerchantRow>(
      `${selectMerchant}
       where merchant.workspace_id = $1
       order by merchant.canonical_name, merchant.id limit $2`,
      [workspaceId, limit],
    );
    return result.rows.map(merchant);
  }

  public async getMerchant(
    workspaceId: string,
    merchantId: string,
  ): Promise<ManagedMerchantRecord | null> {
    const result = await this.pool.query<MerchantRow>(
      `${selectMerchant} where merchant.workspace_id = $1 and merchant.id = $2`,
      [workspaceId, merchantId],
    );
    const row = result.rows[0];
    return row === undefined ? null : merchant(row);
  }

  public async updateMerchant(
    workspaceId: string,
    merchantId: string,
    input: UpdateManagedMerchantInput,
  ): Promise<ManagedMerchantRecord> {
    const actorId = requireText('actorId', input.actorId, 200);
    const canonicalName =
      input.canonicalName === undefined
        ? undefined
        : requireText('canonicalName', input.canonicalName, 500);
    const merchantGroup = optionalText('merchantGroup', input.merchantGroup, 500);
    const mcc = requireMcc(input.mcc);
    const normalizedKey =
      canonicalName === undefined
        ? undefined
        : normalizeTransactionDescription(canonicalName).normalized;
    if (normalizedKey !== undefined && normalizedKey.length === 0) {
      throw new TypeError('canonicalName must produce a non-empty normalized key.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const current = await client.query(
        `select 1 from merchant where workspace_id = $1 and id = $2 for update`,
        [workspaceId, merchantId],
      );
      if (current.rowCount !== 1) throw new ClassificationManagementNotFoundError('merchant');
      if (input.defaultCategoryId !== undefined) {
        await requireVisibleCategory(client, workspaceId, input.defaultCategoryId);
      }
      await client.query(
        `update merchant set
           canonical_name = coalesce($3::text, canonical_name),
           normalized_key = coalesce($4::text, normalized_key),
           merchant_group = case when $5::boolean then $6::text else merchant_group end,
           mcc = case when $7::boolean then $8::text else mcc end,
           default_category_id = case when $9::boolean then $10::uuid else default_category_id end,
           review_status = coalesce($11::text, review_status),
           updated_at = now()
         where workspace_id = $1 and id = $2`,
        [
          workspaceId,
          merchantId,
          canonicalName ?? null,
          normalizedKey ?? null,
          input.merchantGroup !== undefined,
          merchantGroup ?? null,
          input.mcc !== undefined,
          mcc ?? null,
          input.defaultCategoryId !== undefined,
          input.defaultCategoryId ?? null,
          input.reviewStatus ?? null,
        ],
      );
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'MERCHANT_UPDATED', 'MERCHANT', $3,
                   jsonb_build_object('fields', $4::text[]))`,
        [workspaceId, actorId, merchantId, Object.keys(input).filter((key) => key !== 'actorId')],
      );
      await client.query('commit');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    const updated = await this.getMerchant(workspaceId, merchantId);
    if (updated === null) throw new ClassificationManagementNotFoundError('merchant');
    return updated;
  }

  public async mergeMerchants(
    workspaceId: string,
    sourceMerchantId: string,
    targetMerchantId: string,
    actorIdInput: string,
  ): Promise<ManagedMerchantRecord> {
    const actorId = requireText('actorId', actorIdInput, 200);
    if (sourceMerchantId === targetMerchantId) {
      throw new TypeError('Source and target merchants must differ.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const locked = await client.query<MerchantRow>(
        `${selectMerchant}
         where merchant.workspace_id = $1 and merchant.id = any($2::uuid[])
         order by merchant.id for update of merchant`,
        [workspaceId, [sourceMerchantId, targetMerchantId]],
      );
      const source = locked.rows.find(({ id }) => id === sourceMerchantId);
      const target = locked.rows.find(({ id }) => id === targetMerchantId);
      if (source === undefined || target === undefined) {
        throw new ClassificationManagementNotFoundError('merchant');
      }
      const aliasOwner = await client.query<{ merchant_id: string }>(
        `select merchant_id from merchant_alias
         where workspace_id = $1 and alias_normalized = $2 for update`,
        [workspaceId, source.normalized_key],
      );
      if (
        aliasOwner.rows[0] !== undefined &&
        aliasOwner.rows[0].merchant_id !== sourceMerchantId &&
        aliasOwner.rows[0].merchant_id !== targetMerchantId
      ) {
        throw new ClassificationManagementInvariantError(
          'Source merchant key is already an alias of another merchant.',
        );
      }
      await client.query(
        `insert into merchant_alias (
           workspace_id, merchant_id, alias_normalized, match_type, source,
           confidence, is_active, is_confirmed
         ) values ($1, $2, $3, 'EXACT', 'USER', '1.0000', true, true)
         on conflict (workspace_id, alias_normalized) do update set
           merchant_id = $2, source = 'USER', confidence = '1.0000',
           is_active = true, is_confirmed = true, updated_at = now()
         where merchant_alias.merchant_id in ($2, $4)`,
        [workspaceId, targetMerchantId, source.normalized_key, sourceMerchantId],
      );
      await client.query(
        `update merchant_alias set merchant_id = $3, updated_at = now()
         where workspace_id = $1 and merchant_id = $2`,
        [workspaceId, sourceMerchantId, targetMerchantId],
      );
      for (const statement of [
        `update financial_transaction set system_merchant_id = $3, updated_at = now()
         where workspace_id = $1 and system_merchant_id = $2`,
        `update transaction_user_state set merchant_id_override = $3,
             version = version + 1, updated_at = now()
         where workspace_id = $1 and merchant_id_override = $2`,
        `update classification_decision set merchant_id = $3
         where workspace_id = $1 and merchant_id = $2`,
        `update installment_series set merchant_id = $3, updated_at = now()
         where workspace_id = $1 and merchant_id = $2`,
        `update recurring_series set merchant_id = $3, updated_at = now()
         where workspace_id = $1 and merchant_id = $2`,
      ]) {
        await client.query(statement, [workspaceId, sourceMerchantId, targetMerchantId]);
      }
      await client.query(
        `update classification_decision set source_reference = $3
         where workspace_id = $1 and source = 'MERCHANT' and source_reference = $2`,
        [workspaceId, sourceMerchantId, targetMerchantId],
      );
      const rules = await client.query<RuleRow>(
        `${selectRule} where workspace_id = $1 order by id for update`,
        [workspaceId],
      );
      for (const current of rules.rows) {
        const conditions = classificationRuleConditionsSchema.parse(current.conditions);
        const actions = classificationRuleActionsSchema.parse(current.actions);
        const nextConditions = classificationRuleConditionsSchema.parse(
          replaceMerchantReferences(conditions, sourceMerchantId, targetMerchantId),
        );
        const nextActions = classificationRuleActionsSchema.parse(
          replaceMerchantReferences(actions, sourceMerchantId, targetMerchantId),
        );
        if (
          JSON.stringify(nextConditions) !== JSON.stringify(conditions) ||
          JSON.stringify(nextActions) !== JSON.stringify(actions)
        ) {
          await client.query(
            `update classification_rule set conditions = $3::jsonb, actions = $4::jsonb,
                 updated_at = now() where workspace_id = $1 and id = $2`,
            [workspaceId, current.id, JSON.stringify(nextConditions), JSON.stringify(nextActions)],
          );
        }
      }
      if (target.cnpj_hash === null && source.cnpj_hash !== null) {
        await client.query(
          `update merchant set cnpj_hash = null where workspace_id = $1 and id = $2`,
          [workspaceId, sourceMerchantId],
        );
        await client.query(
          `update merchant set cnpj_hash = $3 where workspace_id = $1 and id = $2`,
          [workspaceId, targetMerchantId, source.cnpj_hash],
        );
      }
      const deleted = await client.query(
        `delete from merchant where workspace_id = $1 and id = $2`,
        [workspaceId, sourceMerchantId],
      );
      if (deleted.rowCount !== 1) {
        throw new ClassificationManagementInvariantError('Source merchant merge delete failed.');
      }
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'MERCHANT_MERGED', 'MERCHANT', $3,
                   jsonb_build_object('sourceMerchantId', $4::uuid))`,
        [workspaceId, actorId, targetMerchantId, sourceMerchantId],
      );
      await client.query('commit');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    const merged = await this.getMerchant(workspaceId, targetMerchantId);
    if (merged === null) throw new ClassificationManagementNotFoundError('merchant');
    return merged;
  }

  public async listRules(workspaceId: string, limit = 100): Promise<ClassificationRuleRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('Rule limit must be an integer from 1 to 100.');
    }
    const result = await this.pool.query<RuleRow>(
      `${selectRule}
       where workspace_id = $1 order by priority desc, created_at, id limit $2`,
      [workspaceId, limit],
    );
    return result.rows.map(rule);
  }

  public async createRule(
    workspaceId: string,
    input: {
      actions: unknown;
      actorId: string;
      conditions: unknown;
      name: string;
      priority: number;
      stopProcessing?: boolean;
    },
  ): Promise<ClassificationRuleRecord> {
    try {
      return await new ClassificationRuleRepository(this.pool).createRule(workspaceId, {
        ...input,
        source: 'USER',
      });
    } catch (error) {
      if (error instanceof ClassificationRuleInvariantError) {
        throw new ClassificationManagementInvariantError(error.message);
      }
      throw error;
    }
  }

  public async updateRule(
    workspaceId: string,
    ruleId: string,
    input: UpdateManagedRuleInput,
  ): Promise<ClassificationRuleRecord> {
    const actorId = requireText('actorId', input.actorId, 200);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const selected = await client.query<RuleRow>(
        `${selectRule} where workspace_id = $1 and id = $2 for update`,
        [workspaceId, ruleId],
      );
      const current = selected.rows[0];
      if (current === undefined) throw new ClassificationManagementNotFoundError('rule');
      const name = input.name === undefined ? current.name : requireText('name', input.name, 200);
      const priority =
        input.priority === undefined ? current.priority : requirePriority(input.priority);
      const conditions = classificationRuleConditionsSchema.parse(
        input.conditions ?? current.conditions,
      );
      const actions = classificationRuleActionsSchema.parse(input.actions ?? current.actions);
      await requireRuleActionReferences(client, workspaceId, actions);
      const updated = await client.query<RuleRow>(
        `update classification_rule set
           name = $3, priority = $4, conditions = $5::jsonb, actions = $6::jsonb,
           stop_processing = $7, is_active = $8, updated_at = now()
         where workspace_id = $1 and id = $2
         returning id, workspace_id, name, priority, conditions, actions, stop_processing,
                   source, is_active, hit_count::text, created_at, updated_at`,
        [
          workspaceId,
          ruleId,
          name,
          priority,
          JSON.stringify(conditions),
          JSON.stringify(actions),
          input.stopProcessing ?? current.stop_processing,
          input.isActive ?? current.is_active,
        ],
      );
      const row = updated.rows[0];
      if (row === undefined) throw new ClassificationManagementNotFoundError('rule');
      const activatedSuggestion =
        current.source === 'SYSTEM_SUGGESTION' && !current.is_active && row.is_active;
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, $3, 'CLASSIFICATION_RULE', $4,
                   jsonb_build_object('fields', $5::text[]))`,
        [
          workspaceId,
          actorId,
          activatedSuggestion
            ? 'CLASSIFICATION_RULE_SUGGESTION_CONFIRMED'
            : 'CLASSIFICATION_RULE_UPDATED',
          ruleId,
          Object.keys(input).filter((key) => key !== 'actorId'),
        ],
      );
      await client.query('commit');
      return rule(row);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async deactivateRule(
    workspaceId: string,
    ruleId: string,
    actorIdInput: string,
  ): Promise<void> {
    const actorId = requireText('actorId', actorIdInput, 200);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const updated = await client.query(
        `update classification_rule set is_active = false, updated_at = now()
         where workspace_id = $1 and id = $2 returning id`,
        [workspaceId, ruleId],
      );
      if (updated.rowCount !== 1) throw new ClassificationManagementNotFoundError('rule');
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, 'CLASSIFICATION_RULE_DEACTIVATED',
                   'CLASSIFICATION_RULE', $3, '{}'::jsonb)`,
        [workspaceId, actorId, ruleId],
      );
      await client.query('commit');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async previewRule(
    workspaceId: string,
    ruleId: string,
    input: { from: string; limit: number; to: string },
  ): Promise<ManagedRulePreviewResult> {
    if (input.from > input.to) throw new TypeError('Rule preview from must not exceed to.');
    const days =
      (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000;
    if (!Number.isFinite(days) || days > 366) {
      throw new TypeError('Rule preview range must be at most 366 days.');
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError('Rule preview limit must be an integer from 1 to 100.');
    }
    const selected = await this.pool.query<RuleRow>(
      `${selectRule} where workspace_id = $1 and id = $2`,
      [workspaceId, ruleId],
    );
    const current = selected.rows[0];
    if (current === undefined) throw new ClassificationManagementNotFoundError('rule');
    const conditions: ClassificationRuleConditions = classificationRuleConditionsSchema.parse(
      current.conditions,
    );
    const actions = classificationRuleActionsSchema.parse(current.actions);
    const candidates = await this.pool.query<PreviewRow>(
      `select
         ft.id, ft.financial_account_id, fa.account_type, ft.description_normalized,
         ft.system_direction, ft.system_financial_role, ft.provider_type,
         ft.provider_amount_signed::text, ft.provider_currency,
         ft.account_currency_amount_signed::text, ft.account_currency,
         ft.transaction_local_date::text as local_date, ft.installment_total,
         ft.system_merchant_id as merchant_id, merchant.normalized_key as merchant_normalized_key,
         ft.provider_category_id
       from financial_transaction ft
       join financial_account fa
         on fa.workspace_id = ft.workspace_id and fa.id = ft.financial_account_id
       left join merchant
         on merchant.workspace_id = ft.workspace_id and merchant.id = ft.system_merchant_id
       where ft.workspace_id = $1
         and ft.transaction_local_date between $2::date and $3::date
         and ft.deleted_at is null and ft.status <> 'DELETED'
       order by ft.transaction_local_date desc, ft.id desc
       limit 501`,
      [workspaceId, input.from, input.to],
    );
    const scanned = candidates.rows.slice(0, 500);
    const matches: ManagedRulePreviewMatch[] = [];
    for (const candidate of scanned) {
      const evaluation = evaluateClassificationRules(
        [
          {
            actions,
            conditions,
            createdAt: current.created_at,
            id: current.id,
            priority: current.priority,
            stopProcessing: current.stop_processing,
          },
        ],
        previewFacts(candidate),
      );
      if (evaluation.matchedRules.length > 0 && matches.length < input.limit) {
        matches.push({
          description: candidate.description_normalized,
          localDate: candidate.local_date,
          transactionId: candidate.id,
          wouldStopProcessing: evaluation.stoppedByRuleId === current.id,
        });
      }
    }
    return {
      matches,
      policyVersion: classificationRuleEvaluationPolicyVersion,
      scannedCount: scanned.length,
      truncated: candidates.rows.length > 500,
    };
  }
}
