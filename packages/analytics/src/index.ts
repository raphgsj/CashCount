import type { Pool, PoolClient } from 'pg';

import { parseBankDate, type BankDate } from '@cashcount/domain';

export const packageName = '@cashcount/analytics' as const;

export const analyticsGranularities = ['DAY', 'WEEK', 'MONTH'] as const;
export type AnalyticsGranularity = (typeof analyticsGranularities)[number];
export type AnalyticsStatus = 'PENDING' | 'POSTED';

export interface SpendingCashFlowInput {
  accountId?: string;
  categoryId?: string;
  from: string;
  granularity?: AnalyticsGranularity;
  includePending?: boolean;
  merchantId?: string;
  to: string;
}

export interface SpendingMetrics {
  grossSpending: string;
  netSpending: string;
  refundTotal: string;
  transactionCount: number;
}

export interface CashFlowMetrics {
  inflowTotal: string;
  netCashFlow: string;
  outflowTotal: string;
  transactionCount: number;
}

export interface SpendingCashFlowTotal {
  cashFlow: CashFlowMetrics;
  currency: string;
  spending: SpendingMetrics;
  status: AnalyticsStatus;
}

export interface SpendingBreakdownItem extends SpendingMetrics {
  currency: string;
  label: string | null;
  status: AnalyticsStatus;
}

export interface SpendingCashFlowTimePoint {
  cashFlow: CashFlowMetrics;
  currency: string;
  periodStart: BankDate;
  spending: SpendingMetrics;
  status: AnalyticsStatus;
}

export interface AnalyticsFreshness {
  isStale: boolean;
  lastSuccessfulSyncAt: Date | null;
  oldestAccountSyncAt: Date | null;
  staleAfterMinutes: 1440;
}

export type SpendingCashFlowWarning =
  | { affectedAccountCount: number; code: 'CONNECTION_ATTENTION' }
  | {
      affectedAccountCount: number;
      code: 'INCOMPLETE_HISTORY';
      coverageStatuses: string[];
      earliestKnownDate: BankDate | null;
      requestedFrom: BankDate;
    }
  | { affectedAccountCount: number; code: 'STALE_DATA' }
  | { code: 'UNCONVERTED_CURRENCY'; excludedTransactionCount: number }
  | { affectedBillCount: number; code: 'UNRECONCILED_BILL' }
  | {
      code: 'BREAKDOWN_TRUNCATED';
      dimensions: ('CATEGORY' | 'MERCHANT')[];
      limit: 100;
    };

export interface SpendingCashFlowResult {
  categoryBreakdown: SpendingBreakdownItem[];
  freshness: AnalyticsFreshness;
  from: BankDate;
  granularity: AnalyticsGranularity;
  includePending: boolean;
  merchantBreakdown: SpendingBreakdownItem[];
  policyVersion: number;
  timeSeries: SpendingCashFlowTimePoint[];
  to: BankDate;
  totals: SpendingCashFlowTotal[];
  warnings: SpendingCashFlowWarning[];
}

interface TotalRow {
  cashflow_count: number;
  currency: string;
  gross_spending: string;
  inflow_total: string;
  net_cashflow: string;
  net_spending: string;
  outflow_total: string;
  refund_total: string;
  spend_count: number;
  status_bucket: AnalyticsStatus;
}

interface BreakdownRow {
  currency: string;
  gross_spending: string;
  label: string | null;
  net_spending: string;
  refund_total: string;
  spend_count: number;
  status_bucket: AnalyticsStatus;
}

interface TimeRow extends TotalRow {
  period_start: string;
}

interface WorkspaceRow {
  analytics_policy_version: number;
}

interface FreshnessRow {
  attention_count: number;
  is_stale: boolean;
  last_successful_sync_at: Date | null;
  oldest_account_sync_at: Date | null;
  stale_count: number;
}

interface HistoryRow {
  affected_account_count: number;
  coverage_statuses: string[];
  earliest_known_date: string | null;
}

interface CountRow {
  count: number;
}

const eligibleCte = `with eligible as (
  select spend.*, cash.cashflow_effect_amount
  from v_transaction_spend_effect spend
  join v_transaction_cashflow_effect cash
    on cash.workspace_id = spend.workspace_id and cash.id = spend.id
  where spend.workspace_id = $1
    and spend.transaction_local_date between $2::date and $3::date
    and spend.deleted_at is null and spend.status <> 'DELETED'
    and (spend.status = 'POSTED' or ($7::boolean and spend.status = 'PENDING'))
    and ($4::uuid is null or spend.financial_account_id = $4)
    and ($5::uuid is null or spend.effective_category_id = $5)
    and ($6::uuid is null or spend.effective_merchant_id = $6)
)`;

function requireWorkspaceId(workspaceId: string): void {
  if (workspaceId.trim() !== workspaceId || workspaceId.length === 0 || workspaceId.length > 100) {
    throw new TypeError('workspaceId must contain 1 to 100 trimmed characters.');
  }
}

function requireUuid(name: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError(`${name} must be a UUID.`);
  }
}

function normalizeInput(input: SpendingCashFlowInput) {
  const from = parseBankDate(input.from);
  const to = parseBankDate(input.to);
  if (from > to) throw new TypeError('Analytics from must not exceed to.');
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (days > 366) throw new TypeError('Analytics range must be at most 366 days.');
  for (const [name, value] of [
    ['accountId', input.accountId],
    ['categoryId', input.categoryId],
    ['merchantId', input.merchantId],
  ] as const) {
    if (value !== undefined) requireUuid(name, value);
  }
  const granularity = input.granularity ?? 'MONTH';
  if (!analyticsGranularities.includes(granularity)) {
    throw new TypeError('Analytics granularity is invalid.');
  }
  return {
    accountId: input.accountId ?? null,
    categoryId: input.categoryId ?? null,
    from,
    granularity,
    includePending: input.includePending ?? false,
    merchantId: input.merchantId ?? null,
    to,
  };
}

function spending(row: TotalRow | BreakdownRow): SpendingMetrics {
  return {
    grossSpending: row.gross_spending,
    netSpending: row.net_spending,
    refundTotal: row.refund_total,
    transactionCount: row.spend_count,
  };
}

function cashFlow(row: TotalRow): CashFlowMetrics {
  return {
    inflowTotal: row.inflow_total,
    netCashFlow: row.net_cashflow,
    outflowTotal: row.outflow_total,
    transactionCount: row.cashflow_count,
  };
}

function values(input: ReturnType<typeof normalizeInput>, workspaceId: string) {
  return [
    workspaceId,
    input.from,
    input.to,
    input.accountId,
    input.categoryId,
    input.merchantId,
    input.includePending,
  ];
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original failure if PostgreSQL already ended the transaction.
  }
}

export class AnalyticsWorkspaceNotFoundError extends Error {
  public constructor() {
    super('The analytics workspace was not found.');
    this.name = 'AnalyticsWorkspaceNotFoundError';
  }
}

export class SpendingCashFlowAnalyticsRepository {
  public constructor(private readonly pool: Pool) {}

  public async summarize(
    workspaceId: string,
    input: SpendingCashFlowInput,
  ): Promise<SpendingCashFlowResult> {
    requireWorkspaceId(workspaceId);
    const normalized = normalizeInput(input);
    const parameters = values(normalized, workspaceId);
    const truncationDimensions: ('CATEGORY' | 'MERCHANT')[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('begin transaction isolation level repeatable read read only');
      const workspace = await client.query<WorkspaceRow>(
        `select analytics_policy_version from workspace where id = $1`,
        [workspaceId],
      );
      const workspaceRow = workspace.rows[0];
      if (workspaceRow === undefined) throw new AnalyticsWorkspaceNotFoundError();

      const totalsResult = await client.query<TotalRow>(
        `${eligibleCte}
         select analytics_currency as currency, status as status_bucket,
           coalesce(sum(greatest(spend_effect_amount, 0)), 0)::numeric(20, 6)::text
             as gross_spending,
           coalesce(sum(greatest(-spend_effect_amount, 0)), 0)::numeric(20, 6)::text
             as refund_total,
           coalesce(sum(spend_effect_amount), 0)::numeric(20, 6)::text as net_spending,
           count(*) filter (where spend_effect_amount <> 0)::integer as spend_count,
           coalesce(sum(greatest(cashflow_effect_amount, 0)), 0)::numeric(20, 6)::text
             as inflow_total,
           coalesce(sum(greatest(-cashflow_effect_amount, 0)), 0)::numeric(20, 6)::text
             as outflow_total,
           coalesce(sum(cashflow_effect_amount), 0)::numeric(20, 6)::text as net_cashflow,
           count(*) filter (where cashflow_effect_amount <> 0)::integer as cashflow_count
         from eligible
         group by analytics_currency, status
         order by analytics_currency, status`,
        parameters,
      );
      if (totalsResult.rows.length > 200) {
        throw new RangeError('Analytics result exceeds the supported currency/status bound.');
      }

      const categoryResult = await client.query<BreakdownRow>(
        `${eligibleCte}
         select eligible.analytics_currency as currency, eligible.status as status_bucket,
           category.name_pt_br as label,
           coalesce(sum(greatest(eligible.spend_effect_amount, 0)), 0)
             ::numeric(20, 6)::text as gross_spending,
           coalesce(sum(greatest(-eligible.spend_effect_amount, 0)), 0)
             ::numeric(20, 6)::text as refund_total,
           coalesce(sum(eligible.spend_effect_amount), 0)::numeric(20, 6)::text as net_spending,
           count(*) filter (where eligible.spend_effect_amount <> 0)::integer as spend_count
         from eligible
         left join category on category.id = eligible.effective_category_id
           and (category.workspace_id is null or category.workspace_id = $1)
         where eligible.spend_effect_amount is not null and eligible.spend_effect_amount <> 0
         group by eligible.analytics_currency, eligible.status,
                  eligible.effective_category_id, category.name_pt_br
         order by abs(sum(eligible.spend_effect_amount)) desc,
                  eligible.analytics_currency, eligible.status, category.name_pt_br nulls last
         limit 101`,
        parameters,
      );
      if (categoryResult.rows.length > 100) truncationDimensions.push('CATEGORY');

      const merchantResult = await client.query<BreakdownRow>(
        `${eligibleCte}
         select eligible.analytics_currency as currency, eligible.status as status_bucket,
           merchant.canonical_name as label,
           coalesce(sum(greatest(eligible.spend_effect_amount, 0)), 0)
             ::numeric(20, 6)::text as gross_spending,
           coalesce(sum(greatest(-eligible.spend_effect_amount, 0)), 0)
             ::numeric(20, 6)::text as refund_total,
           coalesce(sum(eligible.spend_effect_amount), 0)::numeric(20, 6)::text as net_spending,
           count(*) filter (where eligible.spend_effect_amount <> 0)::integer as spend_count
         from eligible
         left join merchant on merchant.workspace_id = eligible.workspace_id
           and merchant.id = eligible.effective_merchant_id
         where eligible.spend_effect_amount is not null and eligible.spend_effect_amount <> 0
         group by eligible.analytics_currency, eligible.status,
                  eligible.effective_merchant_id, merchant.canonical_name
         order by abs(sum(eligible.spend_effect_amount)) desc,
                  eligible.analytics_currency, eligible.status, merchant.canonical_name nulls last
         limit 101`,
        parameters,
      );
      if (merchantResult.rows.length > 100) truncationDimensions.push('MERCHANT');

      const datePart =
        normalized.granularity === 'DAY'
          ? 'day'
          : normalized.granularity === 'WEEK'
            ? 'week'
            : 'month';
      const timeResult = await client.query<TimeRow>(
        `${eligibleCte}
         select date_trunc('${datePart}', transaction_local_date)::date::text as period_start,
           analytics_currency as currency, status as status_bucket,
           coalesce(sum(greatest(spend_effect_amount, 0)), 0)::numeric(20, 6)::text
             as gross_spending,
           coalesce(sum(greatest(-spend_effect_amount, 0)), 0)::numeric(20, 6)::text
             as refund_total,
           coalesce(sum(spend_effect_amount), 0)::numeric(20, 6)::text as net_spending,
           count(*) filter (where spend_effect_amount <> 0)::integer as spend_count,
           coalesce(sum(greatest(cashflow_effect_amount, 0)), 0)::numeric(20, 6)::text
             as inflow_total,
           coalesce(sum(greatest(-cashflow_effect_amount, 0)), 0)::numeric(20, 6)::text
             as outflow_total,
           coalesce(sum(cashflow_effect_amount), 0)::numeric(20, 6)::text as net_cashflow,
           count(*) filter (where cashflow_effect_amount <> 0)::integer as cashflow_count
         from eligible
         where coalesce(spend_effect_amount, 0) <> 0
            or coalesce(cashflow_effect_amount, 0) <> 0
         group by date_trunc('${datePart}', transaction_local_date)::date,
                  analytics_currency, status
         order by period_start, analytics_currency, status`,
        parameters,
      );
      if (timeResult.rows.length > 15_000) {
        throw new RangeError('Analytics time series exceeds the supported response bound.');
      }

      const freshnessResult = await client.query<FreshnessRow>(
        `select
           max(effective_last_successful_sync_at) as last_successful_sync_at,
           min(effective_last_successful_sync_at) as oldest_account_sync_at,
           coalesce(bool_or(is_stale), false) as is_stale,
           count(*) filter (where is_stale)::integer as stale_count,
           count(*) filter (where requires_connection_attention)::integer as attention_count
         from v_account_data_freshness
         where workspace_id = $1 and ($2::uuid is null or financial_account_id = $2)`,
        [workspaceId, normalized.accountId],
      );
      const freshness = freshnessResult.rows[0];
      if (freshness === undefined) throw new Error('Analytics freshness query returned no row.');

      const historyResult = await client.query<HistoryRow>(
        `select count(*)::integer as affected_account_count,
           min(provider_history_earliest_date)::text as earliest_known_date,
           coalesce(array_agg(distinct history_coverage_status)
             filter (where history_coverage_status is not null), '{}'::text[])
             as coverage_statuses
         from v_account_history_coverage
         where workspace_id = $1 and ($2::uuid is null or financial_account_id = $2)
           and (provider_history_earliest_date is null
             or provider_history_earliest_date > $3::date)`,
        [workspaceId, normalized.accountId, normalized.from],
      );
      const history = historyResult.rows[0];
      if (history === undefined) throw new Error('Analytics history query returned no row.');

      const unconvertedResult = await client.query<CountRow>(
        `${eligibleCte}
         select count(*)::integer as count from eligible where has_unconverted_currency`,
        parameters,
      );
      const unconvertedCount = unconvertedResult.rows[0]?.count ?? 0;

      const reconciliationResult = await client.query<CountRow>(
        `select count(*)::integer as count
         from v_credit_card_bill_reconciliation reconciliation
         where reconciliation.workspace_id = $1
           and reconciliation.reconciliation_status <> 'RECONCILED'
           and (
             reconciliation.close_date between $2::date and $3::date
             or reconciliation.due_date between $2::date and $3::date
             or exists (
               select 1 from financial_transaction transaction
               where transaction.workspace_id = reconciliation.workspace_id
                 and transaction.credit_card_bill_id = reconciliation.credit_card_bill_id
                 and transaction.transaction_local_date between $2::date and $3::date
             )
             or exists (
               select 1 from credit_card_bill_payment payment
               where payment.workspace_id = reconciliation.workspace_id
                 and payment.credit_card_bill_id = reconciliation.credit_card_bill_id
                 and payment.payment_date between $2::date and $3::date
             )
           )`,
        [workspaceId, normalized.from, normalized.to],
      );
      const reconciliationCount = reconciliationResult.rows[0]?.count ?? 0;

      const warnings: SpendingCashFlowWarning[] = [];
      if (history.affected_account_count > 0) {
        warnings.push({
          affectedAccountCount: history.affected_account_count,
          code: 'INCOMPLETE_HISTORY',
          coverageStatuses: history.coverage_statuses,
          earliestKnownDate:
            history.earliest_known_date === null
              ? null
              : parseBankDate(history.earliest_known_date),
          requestedFrom: normalized.from,
        });
      }
      if (unconvertedCount > 0) {
        warnings.push({
          code: 'UNCONVERTED_CURRENCY',
          excludedTransactionCount: unconvertedCount,
        });
      }
      if (reconciliationCount > 0) {
        warnings.push({ code: 'UNRECONCILED_BILL', affectedBillCount: reconciliationCount });
      }
      if (freshness.stale_count > 0) {
        warnings.push({ affectedAccountCount: freshness.stale_count, code: 'STALE_DATA' });
      }
      if (freshness.attention_count > 0) {
        warnings.push({
          affectedAccountCount: freshness.attention_count,
          code: 'CONNECTION_ATTENTION',
        });
      }
      if (truncationDimensions.length > 0) {
        warnings.push({
          code: 'BREAKDOWN_TRUNCATED',
          dimensions: truncationDimensions,
          limit: 100,
        });
      }

      await client.query('commit');
      return {
        categoryBreakdown: categoryResult.rows.slice(0, 100).map((row) => ({
          currency: row.currency,
          label: row.label,
          status: row.status_bucket,
          ...spending(row),
        })),
        freshness: {
          isStale: freshness.is_stale,
          lastSuccessfulSyncAt: freshness.last_successful_sync_at,
          oldestAccountSyncAt: freshness.oldest_account_sync_at,
          staleAfterMinutes: 1440,
        },
        from: normalized.from,
        granularity: normalized.granularity,
        includePending: normalized.includePending,
        merchantBreakdown: merchantResult.rows.slice(0, 100).map((row) => ({
          currency: row.currency,
          label: row.label,
          status: row.status_bucket,
          ...spending(row),
        })),
        policyVersion: workspaceRow.analytics_policy_version,
        timeSeries: timeResult.rows.map((row) => ({
          cashFlow: cashFlow(row),
          currency: row.currency,
          periodStart: parseBankDate(row.period_start),
          spending: spending(row),
          status: row.status_bucket,
        })),
        to: normalized.to,
        totals: totalsResult.rows.map((row) => ({
          cashFlow: cashFlow(row),
          currency: row.currency,
          spending: spending(row),
          status: row.status_bucket,
        })),
        warnings,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
