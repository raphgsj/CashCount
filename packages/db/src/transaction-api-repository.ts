import type { Pool } from 'pg';

import {
  TransactionUserStateRepository,
  type FinancialRole,
  type NullableOverridePatch,
  type OverridePatch,
  type TransactionReviewStatus,
} from './transaction-user-state-repository.js';

export type TransactionApiStatus = 'PENDING' | 'POSTED' | 'UNKNOWN';

export interface TransactionApiListInput {
  accountId?: string;
  categoryId?: string;
  cursor?: { id: string; localDate: string };
  from: string;
  limit: number;
  status?: TransactionApiStatus;
  to: string;
  workspaceId: string;
}

export interface TransactionApiUpdateInput {
  actorId: string;
  categoryOverride?: NullableOverridePatch<string>;
  excludedFromSpendOverride?: OverridePatch<boolean>;
  expectedVersion: number;
  financialRoleOverride?: OverridePatch<FinancialRole>;
  merchantOverride?: NullableOverridePatch<string>;
  notes?: string | null;
  reviewStatus?: TransactionReviewStatus;
  tagIds?: string[];
  transactionId: string;
  workspaceId: string;
}

export interface TransactionApiReplacementContext {
  confidence: null | string;
  relatedTransactionId: string;
  relationship: 'PREDECESSOR' | 'SUCCESSOR';
  status: 'AUTO_CONFIRMED' | 'NEEDS_REVIEW' | 'REJECTED' | 'USER_CONFIRMED';
}

export interface TransactionApiTag {
  id: string;
  name: string;
}

export type TransactionApiWarning =
  | {
      accountCurrency: string;
      accountId: string;
      code: 'UNCONVERTED_CURRENCY';
      originalCurrency: string;
    }
  | {
      accountId: string;
      code: 'INCOMPLETE_HISTORY';
      coverageStatus: TransactionHistoryCoverageStatus;
      earliestKnownDate: null | string;
      requestedFrom: string;
    }
  | { accountId: string; code: 'STALE_DATA'; lastSuccessfulSyncAt: Date | null }
  | { accountId: string; code: 'CONNECTION_ATTENTION' };

export type TransactionHistoryCoverageStatus =
  'PARTIAL' | 'PROVIDER_MAXIMUM_RETRIEVED' | 'UNKNOWN' | 'USER_EXTENDED_HISTORY';

export interface TransactionApiRecord {
  accountCurrency: string;
  accountCurrencyAmountSigned: null | string;
  accountId: string;
  accountMaskedNumber: null | string;
  accountName: string;
  accountType: 'CHECKING' | 'CREDIT_CARD' | 'INVESTMENT' | 'OTHER' | 'SAVINGS';
  analyticsAmountSigned: null | string;
  analyticsCurrency: string;
  billCloseDate: null | string;
  billDueDate: null | string;
  billForecastMonth: null | string;
  billId: null | string;
  billStatus: null | string;
  cardLastFour: null | string;
  categoryOverrideEnabled: boolean;
  description: string;
  duplicateReviewStatus: 'CONFIRMED_DISTINCT' | 'CONFIRMED_DUPLICATE' | 'NONE' | 'POSSIBLE';
  effectiveCategoryId: null | string;
  effectiveCategoryName: null | string;
  effectiveCategorySource: string;
  effectiveExclusionSource: string;
  effectiveFinancialRole: FinancialRole | null;
  effectiveFinancialRoleSource: string;
  effectiveIsExcludedFromSpend: boolean;
  effectiveLastSuccessfulSyncAt: Date | null;
  effectiveMerchantId: null | string;
  effectiveMerchantName: null | string;
  effectiveMerchantSource: string;
  financialRoleOverrideEnabled: boolean;
  hasUnconvertedCurrency: boolean;
  historyCoverageStatus: TransactionHistoryCoverageStatus;
  historyEarliestDate: null | string;
  id: string;
  installmentNumber: null | number;
  installmentTotal: null | number;
  installmentTotalAmount: null | string;
  isStale: boolean;
  localDate: string;
  merchantOverrideEnabled: boolean;
  notes: null | string;
  payeeMcc: null | string;
  providerAmountSigned: string;
  providerCurrency: string;
  providerPurchaseAt: Date | null;
  providerTransactionAt: Date;
  purchaseLocalDate: null | string;
  replacementContext: TransactionApiReplacementContext[];
  requiresConnectionAttention: boolean;
  reviewStatus: TransactionReviewStatus;
  status: TransactionApiStatus;
  tags: TransactionApiTag[];
  userStateVersion: number;
  warnings: TransactionApiWarning[];
}

export interface TransactionApiPage {
  items: TransactionApiRecord[];
  nextCursor: { id: string; localDate: string } | null;
  warnings: TransactionApiWarning[];
}

interface AccountWarningRow {
  account_id: string;
  effective_last_successful_sync_at: Date | null;
  history_coverage_status: TransactionHistoryCoverageStatus;
  history_earliest_date: null | string;
  is_stale: boolean;
  requires_connection_attention: boolean;
}

interface TransactionRow {
  account_currency: string;
  account_currency_amount_signed: null | string;
  account_id: string;
  account_masked_number: null | string;
  account_name: string;
  account_type: TransactionApiRecord['accountType'];
  analytics_amount_signed: null | string;
  analytics_currency: string;
  bill_close_date: null | string;
  bill_due_date: null | string;
  bill_forecast_month: null | string;
  bill_id: null | string;
  bill_status: null | string;
  card_last_four: null | string;
  category_override_enabled: boolean;
  description: string;
  duplicate_review_status: TransactionApiRecord['duplicateReviewStatus'];
  effective_category_id: null | string;
  effective_category_name: null | string;
  effective_category_source: string;
  effective_exclusion_source: string;
  effective_financial_role: FinancialRole | null;
  effective_financial_role_source: string;
  effective_is_excluded_from_spend: boolean;
  effective_last_successful_sync_at: Date | null;
  effective_merchant_id: null | string;
  effective_merchant_name: null | string;
  effective_merchant_source: string;
  financial_role_override_enabled: boolean;
  has_unconverted_currency: boolean;
  history_coverage_status: TransactionHistoryCoverageStatus;
  history_earliest_date: null | string;
  id: string;
  installment_number: null | number;
  installment_total: null | number;
  installment_total_amount: null | string;
  is_stale: boolean;
  local_date: string;
  merchant_override_enabled: boolean;
  notes: null | string;
  payee_mcc: null | string;
  provider_amount_signed: string;
  provider_currency: string;
  provider_purchase_at: Date | null;
  provider_transaction_at: Date;
  purchase_local_date: null | string;
  replacement_context: TransactionApiReplacementContext[];
  requires_connection_attention: boolean;
  review_status: TransactionReviewStatus;
  status: TransactionApiStatus;
  tags: TransactionApiTag[];
  user_state_version: number;
}

const selectTransaction = `select
  e.id,
  e.financial_account_id as account_id,
  fa.account_type,
  fa.name as account_name,
  fa.masked_number as account_masked_number,
  e.status,
  e.provider_amount_signed::text,
  e.provider_currency,
  e.account_currency_amount_signed::text,
  e.account_currency,
  e.analytics_amount_signed::text,
  e.analytics_currency,
  e.provider_transaction_at,
  e.transaction_local_date::text as local_date,
  e.provider_purchase_at,
  e.purchase_local_date::text,
  e.description_original as description,
  e.duplicate_review_status,
  e.effective_category_id,
  coalesce(category.name_pt_br, category.name_en) as effective_category_name,
  e.effective_category_source,
  e.category_override_enabled,
  e.effective_merchant_id,
  merchant.canonical_name as effective_merchant_name,
  e.effective_merchant_source,
  e.merchant_override_enabled,
  e.effective_financial_role,
  e.effective_financial_role_source,
  e.financial_role_override_enabled,
  e.effective_is_excluded_from_spend,
  e.effective_exclusion_source,
  e.user_notes as notes,
  e.user_review_status as review_status,
  e.user_state_version,
  e.installment_number,
  e.installment_total,
  e.installment_total_amount::text,
  e.payee_mcc,
  e.card_last_four,
  e.bill_forecast_month::text,
  bill.id as bill_id,
  bill.status as bill_status,
  bill.due_date::text as bill_due_date,
  bill.close_date::text as bill_close_date,
  coalesce(freshness.effective_last_successful_sync_at, fa.last_successful_sync_at)
    as effective_last_successful_sync_at,
  coalesce(freshness.is_stale, true) as is_stale,
  coalesce(freshness.requires_connection_attention, true) as requires_connection_attention,
  coalesce(history.provider_history_earliest_date, fa.provider_history_earliest_date)::text
    as history_earliest_date,
  coalesce(history.history_coverage_status, fa.history_coverage_status) as history_coverage_status,
  e.has_unconverted_currency,
  coalesce(tags.items, '[]'::jsonb) as tags,
  coalesce(replacements.items, '[]'::jsonb) as replacement_context
from v_financial_transaction_effective e
join financial_account fa
  on fa.workspace_id = e.workspace_id and fa.id = e.financial_account_id
left join category on category.id = e.effective_category_id
left join merchant
  on merchant.workspace_id = e.workspace_id and merchant.id = e.effective_merchant_id
left join credit_card_bill bill
  on bill.workspace_id = e.workspace_id and bill.id = e.credit_card_bill_id
left join v_account_data_freshness freshness
  on freshness.workspace_id = e.workspace_id
 and freshness.financial_account_id = e.financial_account_id
left join v_account_history_coverage history
  on history.workspace_id = e.workspace_id
 and history.financial_account_id = e.financial_account_id
left join lateral (
  select jsonb_agg(jsonb_build_object('id', tag.id, 'name', tag.name) order by tag.name, tag.id)
    as items
  from transaction_tag
  join tag
    on tag.workspace_id = transaction_tag.workspace_id and tag.id = transaction_tag.tag_id
  where transaction_tag.workspace_id = e.workspace_id
    and transaction_tag.financial_transaction_id = e.id
) tags on true
left join lateral (
  select jsonb_agg(
    jsonb_build_object(
      'confidence', link.confidence::text,
      'relatedTransactionId',
        case when link.predecessor_transaction_id = e.id
          then link.successor_transaction_id else link.predecessor_transaction_id end,
      'relationship',
        case when link.predecessor_transaction_id = e.id then 'PREDECESSOR' else 'SUCCESSOR' end,
      'status', link.status
    ) order by link.detected_at, link.id
  ) as items
  from transaction_identity_link link
  where link.workspace_id = e.workspace_id
    and (link.predecessor_transaction_id = e.id or link.successor_transaction_id = e.id)
) replacements on true`;

function requireDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new TypeError(`${field} must be a valid ISO date.`);
  }
}

function warnings(row: TransactionRow, requestedFrom: string): TransactionApiWarning[] {
  const result: TransactionApiWarning[] = [];
  if (row.has_unconverted_currency) {
    result.push({
      accountCurrency: row.account_currency,
      accountId: row.account_id,
      code: 'UNCONVERTED_CURRENCY',
      originalCurrency: row.provider_currency,
    });
  }
  if (row.history_earliest_date === null || requestedFrom < row.history_earliest_date) {
    result.push({
      accountId: row.account_id,
      code: 'INCOMPLETE_HISTORY',
      coverageStatus: row.history_coverage_status,
      earliestKnownDate: row.history_earliest_date,
      requestedFrom,
    });
  }
  if (row.is_stale) {
    result.push({
      accountId: row.account_id,
      code: 'STALE_DATA',
      lastSuccessfulSyncAt: row.effective_last_successful_sync_at,
    });
  }
  if (row.requires_connection_attention) {
    result.push({ accountId: row.account_id, code: 'CONNECTION_ATTENTION' });
  }
  return result;
}

function accountWarnings(row: AccountWarningRow, requestedFrom: string): TransactionApiWarning[] {
  const result: TransactionApiWarning[] = [];
  if (row.history_earliest_date === null || requestedFrom < row.history_earliest_date) {
    result.push({
      accountId: row.account_id,
      code: 'INCOMPLETE_HISTORY',
      coverageStatus: row.history_coverage_status,
      earliestKnownDate: row.history_earliest_date,
      requestedFrom,
    });
  }
  if (row.is_stale) {
    result.push({
      accountId: row.account_id,
      code: 'STALE_DATA',
      lastSuccessfulSyncAt: row.effective_last_successful_sync_at,
    });
  }
  if (row.requires_connection_attention) {
    result.push({ accountId: row.account_id, code: 'CONNECTION_ATTENTION' });
  }
  return result;
}

function record(row: TransactionRow, requestedFrom: string): TransactionApiRecord {
  return {
    accountCurrency: row.account_currency,
    accountCurrencyAmountSigned: row.account_currency_amount_signed,
    accountId: row.account_id,
    accountMaskedNumber: row.account_masked_number,
    accountName: row.account_name,
    accountType: row.account_type,
    analyticsAmountSigned: row.analytics_amount_signed,
    analyticsCurrency: row.analytics_currency,
    billCloseDate: row.bill_close_date,
    billDueDate: row.bill_due_date,
    billForecastMonth: row.bill_forecast_month,
    billId: row.bill_id,
    billStatus: row.bill_status,
    cardLastFour: row.card_last_four,
    categoryOverrideEnabled: row.category_override_enabled,
    description: row.description,
    duplicateReviewStatus: row.duplicate_review_status,
    effectiveCategoryId: row.effective_category_id,
    effectiveCategoryName: row.effective_category_name,
    effectiveCategorySource: row.effective_category_source,
    effectiveExclusionSource: row.effective_exclusion_source,
    effectiveFinancialRole: row.effective_financial_role,
    effectiveFinancialRoleSource: row.effective_financial_role_source,
    effectiveIsExcludedFromSpend: row.effective_is_excluded_from_spend,
    effectiveLastSuccessfulSyncAt: row.effective_last_successful_sync_at,
    effectiveMerchantId: row.effective_merchant_id,
    effectiveMerchantName: row.effective_merchant_name,
    effectiveMerchantSource: row.effective_merchant_source,
    financialRoleOverrideEnabled: row.financial_role_override_enabled,
    hasUnconvertedCurrency: row.has_unconverted_currency,
    historyCoverageStatus: row.history_coverage_status,
    historyEarliestDate: row.history_earliest_date,
    id: row.id,
    installmentNumber: row.installment_number,
    installmentTotal: row.installment_total,
    installmentTotalAmount: row.installment_total_amount,
    isStale: row.is_stale,
    localDate: row.local_date,
    merchantOverrideEnabled: row.merchant_override_enabled,
    notes: row.notes,
    payeeMcc: row.payee_mcc,
    providerAmountSigned: row.provider_amount_signed,
    providerCurrency: row.provider_currency,
    providerPurchaseAt: row.provider_purchase_at,
    providerTransactionAt: row.provider_transaction_at,
    purchaseLocalDate: row.purchase_local_date,
    replacementContext: row.replacement_context,
    requiresConnectionAttention: row.requires_connection_attention,
    reviewStatus: row.review_status,
    status: row.status,
    tags: row.tags,
    userStateVersion: row.user_state_version,
    warnings: warnings(row, requestedFrom),
  };
}

export class TransactionApiRepository {
  public constructor(private readonly pool: Pool) {}

  public async get(
    workspaceId: string,
    transactionId: string,
  ): Promise<TransactionApiRecord | null> {
    const result = await this.pool.query<TransactionRow>(
      `${selectTransaction}
       where e.workspace_id = $1 and e.id = $2 and e.deleted_at is null and e.status <> 'DELETED'`,
      [workspaceId, transactionId],
    );
    const row = result.rows[0];
    return row === undefined ? null : record(row, row.local_date);
  }

  public async list(input: TransactionApiListInput): Promise<TransactionApiPage> {
    requireDate(input.from, 'Transaction list from');
    requireDate(input.to, 'Transaction list to');
    if (input.from > input.to) throw new TypeError('Transaction list from must not exceed to.');
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new TypeError('Transaction list limit must be an integer from 1 to 100.');
    }
    const values: unknown[] = [input.workspaceId, input.from, input.to];
    const conditions = [
      'e.workspace_id = $1',
      'e.transaction_local_date between $2::date and $3::date',
      'e.deleted_at is null',
      "e.status <> 'DELETED'",
    ];
    const add = (value: unknown): number => values.push(value);
    if (input.accountId !== undefined) {
      const position = add(input.accountId);
      conditions.push(`e.financial_account_id = $${position}::uuid`);
    }
    if (input.categoryId !== undefined) {
      const position = add(input.categoryId);
      conditions.push(`e.effective_category_id = $${position}::uuid`);
    }
    if (input.status !== undefined) {
      const position = add(input.status);
      conditions.push(`e.status = $${position}`);
    }
    if (input.cursor !== undefined) {
      requireDate(input.cursor.localDate, 'Transaction cursor localDate');
      const datePosition = add(input.cursor.localDate);
      const idPosition = add(input.cursor.id);
      conditions.push(
        `(e.transaction_local_date, e.id) < ($${datePosition}::date, $${idPosition}::uuid)`,
      );
    }
    const limitPosition = add(input.limit + 1);
    const result = await this.pool.query<TransactionRow>(
      `${selectTransaction}
       where ${conditions.join(' and ')}
       order by e.transaction_local_date desc, e.id desc
       limit $${limitPosition}`,
      values,
    );
    const hasNext = result.rows.length > input.limit;
    const rows = hasNext ? result.rows.slice(0, input.limit) : result.rows;
    const last = rows.at(-1);
    const accountScopeValues =
      input.accountId === undefined ? [input.workspaceId] : [input.workspaceId, input.accountId];
    const warningResult = await this.pool.query<AccountWarningRow>(
      `select
         fa.id as account_id,
         coalesce(freshness.effective_last_successful_sync_at, fa.last_successful_sync_at)
           as effective_last_successful_sync_at,
         coalesce(freshness.is_stale, true) as is_stale,
         coalesce(freshness.requires_connection_attention, true)
           as requires_connection_attention,
         coalesce(history.provider_history_earliest_date, fa.provider_history_earliest_date)::text
           as history_earliest_date,
         coalesce(history.history_coverage_status, fa.history_coverage_status)
           as history_coverage_status
       from financial_account fa
       left join v_account_data_freshness freshness
         on freshness.workspace_id = fa.workspace_id
        and freshness.financial_account_id = fa.id
       left join v_account_history_coverage history
         on history.workspace_id = fa.workspace_id
        and history.financial_account_id = fa.id
       where fa.workspace_id = $1
         ${input.accountId === undefined ? '' : 'and fa.id = $2::uuid'}
       order by fa.id`,
      accountScopeValues,
    );
    return {
      items: rows.map((row) => record(row, input.from)),
      nextCursor:
        hasNext && last !== undefined ? { id: last.id, localDate: last.local_date } : null,
      warnings: warningResult.rows.flatMap((row) => accountWarnings(row, input.from)),
    };
  }

  public async update(input: TransactionApiUpdateInput): Promise<TransactionApiRecord> {
    await new TransactionUserStateRepository(this.pool).applyCorrection({
      ...input,
      actorType: 'USER',
      application: { mode: 'TRANSACTION_ONLY' },
    });
    const updated = await this.get(input.workspaceId, input.transactionId);
    if (updated === null) throw new Error('Updated transaction unexpectedly disappeared.');
    return updated;
  }
}
