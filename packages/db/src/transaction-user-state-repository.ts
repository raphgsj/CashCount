import type { Pool, PoolClient } from 'pg';

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

export const transactionReviewStatuses = [
  'UNREVIEWED',
  'NEEDS_REVIEW',
  'CONFIRMED',
  'IGNORED',
] as const;

export type FinancialRole = (typeof financialRoles)[number];
export type TransactionReviewStatus = (typeof transactionReviewStatuses)[number];
export type UserStateActorType = 'MIGRATION' | 'SYSTEM' | 'USER';

export type NullableOverridePatch<T> =
  { mode: 'CLEAR' } | { mode: 'INHERIT' } | { mode: 'SET'; value: T };

export type OverridePatch<T> = { mode: 'INHERIT' } | { mode: 'SET'; value: T };

export interface UpdateTransactionUserStateInput {
  actorId?: string | null;
  actorType: UserStateActorType;
  categoryOverride?: NullableOverridePatch<string>;
  excludedFromSpendOverride?: OverridePatch<boolean>;
  expectedVersion: number;
  financialRoleOverride?: OverridePatch<FinancialRole>;
  merchantOverride?: NullableOverridePatch<string>;
  notes?: string | null;
  reviewStatus?: TransactionReviewStatus;
  transactionId: string;
  workspaceId: string;
}

export interface TransactionUserStateRecord {
  categoryIdOverride: string | null;
  categoryOverrideEnabled: boolean;
  createdAt: Date;
  excludedFromSpendOverride: boolean | null;
  financialRoleOverride: FinancialRole | null;
  financialRoleOverrideEnabled: boolean;
  financialTransactionId: string;
  merchantIdOverride: string | null;
  merchantOverrideEnabled: boolean;
  notes: string | null;
  reviewStatus: TransactionReviewStatus;
  updatedAt: Date;
  updatedByActorId: string | null;
  updatedByActorType: UserStateActorType;
  version: number;
  workspaceId: string;
}

export interface EffectiveTransactionUserState {
  analyticsAmountSigned: string | null;
  analyticsCurrency: string;
  categoryOverrideEnabled: boolean;
  effectiveCategoryId: string | null;
  effectiveCategorySource: string;
  effectiveExclusionSource: string;
  effectiveFinancialRole: FinancialRole | null;
  effectiveFinancialRoleSource: string;
  effectiveIsExcludedFromSpend: boolean;
  effectiveMerchantId: string | null;
  effectiveMerchantSource: string;
  financialTransactionId: string;
  financialRoleOverrideEnabled: boolean;
  hasUnconvertedCurrency: boolean;
  merchantOverrideEnabled: boolean;
  notes: string | null;
  reviewStatus: TransactionReviewStatus;
  userStateVersion: number;
  workspaceId: string;
}

interface LockedStateRow {
  category_id_override: string | null;
  category_override_enabled: boolean | null;
  created_at: Date | null;
  excluded_from_spend_override: boolean | null;
  financial_role_override: FinancialRole | null;
  financial_role_override_enabled: boolean | null;
  merchant_id_override: string | null;
  merchant_override_enabled: boolean | null;
  notes: string | null;
  review_status: TransactionReviewStatus | null;
  state_transaction_id: string | null;
  updated_at: Date | null;
  updated_by_actor_id: string | null;
  updated_by_actor_type: UserStateActorType | null;
  version: number | null;
  workspace_id: string;
}

interface EffectiveStateRow {
  analytics_amount_signed: string | null;
  analytics_currency: string;
  category_override_enabled: boolean;
  effective_category_id: string | null;
  effective_category_source: string;
  effective_exclusion_source: string;
  effective_financial_role: FinancialRole | null;
  effective_financial_role_source: string;
  effective_is_excluded_from_spend: boolean;
  effective_merchant_id: string | null;
  effective_merchant_source: string;
  financial_role_override_enabled: boolean;
  has_unconverted_currency: boolean;
  id: string;
  merchant_override_enabled: boolean;
  user_notes: string | null;
  user_review_status: TransactionReviewStatus;
  user_state_version: number;
  workspace_id: string;
}

interface StateRow {
  category_id_override: string | null;
  category_override_enabled: boolean;
  created_at: Date;
  excluded_from_spend_override: boolean | null;
  financial_role_override: FinancialRole | null;
  financial_role_override_enabled: boolean;
  financial_transaction_id: string;
  merchant_id_override: string | null;
  merchant_override_enabled: boolean;
  notes: string | null;
  review_status: TransactionReviewStatus;
  updated_at: Date;
  updated_by_actor_id: string | null;
  updated_by_actor_type: UserStateActorType;
  version: number;
  workspace_id: string;
}

interface ResolvedState {
  categoryIdOverride: string | null;
  categoryOverrideEnabled: boolean;
  excludedFromSpendOverride: boolean | null;
  financialRoleOverride: FinancialRole | null;
  financialRoleOverrideEnabled: boolean;
  merchantIdOverride: string | null;
  merchantOverrideEnabled: boolean;
  notes: string | null;
  reviewStatus: TransactionReviewStatus;
}

export class TransactionNotFoundError extends Error {
  public constructor() {
    super('Transaction was not found in the required workspace.');
    this.name = 'TransactionNotFoundError';
  }
}

export class TransactionUserStateConflictError extends Error {
  public readonly actualVersion: number;
  public readonly expectedVersion: number;

  public constructor(expectedVersion: number, actualVersion: number) {
    super(
      `Transaction user-state version conflict: expected ${expectedVersion}, got ${actualVersion}.`,
    );
    this.name = 'TransactionUserStateConflictError';
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

function mapState(row: StateRow): TransactionUserStateRecord {
  return {
    categoryIdOverride: row.category_id_override,
    categoryOverrideEnabled: row.category_override_enabled,
    createdAt: row.created_at,
    excludedFromSpendOverride: row.excluded_from_spend_override,
    financialRoleOverride: row.financial_role_override,
    financialRoleOverrideEnabled: row.financial_role_override_enabled,
    financialTransactionId: row.financial_transaction_id,
    merchantIdOverride: row.merchant_id_override,
    merchantOverrideEnabled: row.merchant_override_enabled,
    notes: row.notes,
    reviewStatus: row.review_status,
    updatedAt: row.updated_at,
    updatedByActorId: row.updated_by_actor_id,
    updatedByActorType: row.updated_by_actor_type,
    version: row.version,
    workspaceId: row.workspace_id,
  };
}

function mapEffectiveState(row: EffectiveStateRow): EffectiveTransactionUserState {
  return {
    analyticsAmountSigned: row.analytics_amount_signed,
    analyticsCurrency: row.analytics_currency,
    categoryOverrideEnabled: row.category_override_enabled,
    effectiveCategoryId: row.effective_category_id,
    effectiveCategorySource: row.effective_category_source,
    effectiveExclusionSource: row.effective_exclusion_source,
    effectiveFinancialRole: row.effective_financial_role,
    effectiveFinancialRoleSource: row.effective_financial_role_source,
    effectiveIsExcludedFromSpend: row.effective_is_excluded_from_spend,
    effectiveMerchantId: row.effective_merchant_id,
    effectiveMerchantSource: row.effective_merchant_source,
    financialRoleOverrideEnabled: row.financial_role_override_enabled,
    financialTransactionId: row.id,
    hasUnconvertedCurrency: row.has_unconverted_currency,
    merchantOverrideEnabled: row.merchant_override_enabled,
    notes: row.user_notes,
    reviewStatus: row.user_review_status,
    userStateVersion: row.user_state_version,
    workspaceId: row.workspace_id,
  };
}

function resolveNullableOverride<T>(
  patch: NullableOverridePatch<T> | undefined,
  enabled: boolean,
  value: T | null,
): { enabled: boolean; value: T | null } {
  if (patch === undefined) {
    return { enabled, value };
  }

  if (patch.mode === 'INHERIT') {
    return { enabled: false, value: null };
  }

  if (patch.mode === 'CLEAR') {
    return { enabled: true, value: null };
  }

  return { enabled: true, value: patch.value };
}

function resolveOverride<T>(
  patch: OverridePatch<T> | undefined,
  enabled: boolean,
  value: T | null,
): { enabled: boolean; value: T | null } {
  if (patch === undefined) {
    return { enabled, value };
  }

  if (patch.mode === 'INHERIT') {
    return { enabled: false, value: null };
  }

  return { enabled: true, value: patch.value };
}

function resolveState(row: LockedStateRow, input: UpdateTransactionUserStateInput): ResolvedState {
  const category = resolveNullableOverride(
    input.categoryOverride,
    row.category_override_enabled ?? false,
    row.category_id_override,
  );
  const merchant = resolveNullableOverride(
    input.merchantOverride,
    row.merchant_override_enabled ?? false,
    row.merchant_id_override,
  );
  const role = resolveOverride(
    input.financialRoleOverride,
    row.financial_role_override_enabled ?? false,
    row.financial_role_override,
  );
  const exclusion = resolveOverride(
    input.excludedFromSpendOverride,
    row.excluded_from_spend_override !== null,
    row.excluded_from_spend_override,
  );

  return {
    categoryIdOverride: category.value,
    categoryOverrideEnabled: category.enabled,
    excludedFromSpendOverride: exclusion.enabled ? exclusion.value : null,
    financialRoleOverride: role.value,
    financialRoleOverrideEnabled: role.enabled,
    merchantIdOverride: merchant.value,
    merchantOverrideEnabled: merchant.enabled,
    notes: input.notes === undefined ? row.notes : input.notes,
    reviewStatus: input.reviewStatus ?? row.review_status ?? 'UNREVIEWED',
  };
}

async function lockState(
  client: PoolClient,
  workspaceId: string,
  transactionId: string,
): Promise<LockedStateRow | null> {
  const result = await client.query<LockedStateRow>(
    `select
       ft.workspace_id,
       tus.financial_transaction_id as state_transaction_id,
       tus.category_override_enabled,
       tus.category_id_override,
       tus.merchant_override_enabled,
       tus.merchant_id_override,
       tus.financial_role_override_enabled,
       tus.financial_role_override,
       tus.excluded_from_spend_override,
       tus.notes,
       tus.review_status,
       tus.version,
       tus.updated_by_actor_type,
       tus.updated_by_actor_id,
       tus.created_at,
       tus.updated_at
     from financial_transaction ft
     left join transaction_user_state tus
       on tus.workspace_id = ft.workspace_id
      and tus.financial_transaction_id = ft.id
     where ft.workspace_id = $1 and ft.id = $2
     for update of ft`,
    [workspaceId, transactionId],
  );

  return result.rows[0] ?? null;
}

export class TransactionUserStateRepository {
  public constructor(private readonly pool: Pool) {}

  public async get(
    workspaceId: string,
    transactionId: string,
  ): Promise<TransactionUserStateRecord | null> {
    const result = await this.pool.query<StateRow>(
      `select *
       from transaction_user_state
       where workspace_id = $1 and financial_transaction_id = $2`,
      [workspaceId, transactionId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapState(row);
  }

  public async getEffective(
    workspaceId: string,
    transactionId: string,
  ): Promise<EffectiveTransactionUserState | null> {
    const result = await this.pool.query<EffectiveStateRow>(
      `select
         id,
         workspace_id,
         effective_category_id,
         effective_category_source,
         effective_merchant_id,
         effective_merchant_source,
         effective_financial_role,
         effective_financial_role_source,
         effective_is_excluded_from_spend,
         effective_exclusion_source,
         analytics_amount_signed,
         analytics_currency,
         has_unconverted_currency,
         user_review_status,
         user_notes,
         user_state_version,
         category_override_enabled,
         merchant_override_enabled,
         financial_role_override_enabled
       from v_financial_transaction_effective
       where workspace_id = $1 and id = $2`,
      [workspaceId, transactionId],
    );

    const row = result.rows[0];
    return row === undefined ? null : mapEffectiveState(row);
  }

  public async update(input: UpdateTransactionUserStateInput): Promise<TransactionUserStateRecord> {
    const client = await this.pool.connect();

    try {
      await client.query('begin');
      const current = await lockState(client, input.workspaceId, input.transactionId);

      if (current === null) {
        throw new TransactionNotFoundError();
      }

      const actualVersion = current.version ?? 0;
      if (actualVersion !== input.expectedVersion) {
        throw new TransactionUserStateConflictError(input.expectedVersion, actualVersion);
      }

      const next = resolveState(current, input);
      const parameters = [
        input.transactionId,
        input.workspaceId,
        next.categoryOverrideEnabled,
        next.categoryIdOverride,
        next.merchantOverrideEnabled,
        next.merchantIdOverride,
        next.financialRoleOverrideEnabled,
        next.financialRoleOverride,
        next.excludedFromSpendOverride,
        next.notes,
        next.reviewStatus,
        input.actorType,
        input.actorId ?? null,
      ];
      let result;

      if (actualVersion === 0) {
        result = await client.query<StateRow>(
          `insert into transaction_user_state (
             financial_transaction_id,
             workspace_id,
             category_override_enabled,
             category_id_override,
             merchant_override_enabled,
             merchant_id_override,
             financial_role_override_enabled,
             financial_role_override,
             excluded_from_spend_override,
             notes,
             review_status,
             updated_by_actor_type,
             updated_by_actor_id
           ) values (
             $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
           )
           on conflict (financial_transaction_id) do nothing
           returning *`,
          parameters,
        );
      } else {
        result = await client.query<StateRow>(
          `update transaction_user_state
           set category_override_enabled = $3,
               category_id_override = $4,
               merchant_override_enabled = $5,
               merchant_id_override = $6,
               financial_role_override_enabled = $7,
               financial_role_override = $8,
               excluded_from_spend_override = $9,
               notes = $10,
               review_status = $11,
               updated_by_actor_type = $12,
               updated_by_actor_id = $13,
               version = version + 1,
               updated_at = now()
           where financial_transaction_id = $1
             and workspace_id = $2
             and version = $14
           returning *`,
          [...parameters, input.expectedVersion],
        );
      }

      const updated = result.rows[0];
      if (updated === undefined) {
        const conflict = await client.query<{ version: number }>(
          `select version from transaction_user_state
           where workspace_id = $1 and financial_transaction_id = $2`,
          [input.workspaceId, input.transactionId],
        );
        throw new TransactionUserStateConflictError(
          input.expectedVersion,
          conflict.rows[0]?.version ?? actualVersion,
        );
      }

      await client.query('commit');
      return mapState(updated);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
