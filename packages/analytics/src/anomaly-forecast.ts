import type { Pool, PoolClient } from 'pg';

import { deriveFinancialDate, parseBankDate, type BankDate } from '@cashcount/domain';

import type { AnalyticsFreshness } from './index.js';

export const anomalyRules = [
  'CATEGORY_SPEND_SPIKE',
  'DUPLICATE_LIKE_CHARGE',
  'MERCHANT_AMOUNT_SPIKE',
  'NEW_RECURRING_MERCHANT',
  'RECURRING_AMOUNT_INCREASE',
] as const;
export type AnomalyRule = (typeof anomalyRules)[number];

export interface AnomalyCandidate {
  baselineValue: string | null;
  categoryLabel: string | null;
  currency: string;
  deviationPercent: string | null;
  merchantLabel: string | null;
  observedOn: BankDate;
  observedValue: string;
  rule: AnomalyRule;
  status: 'CANDIDATE';
  thresholdValue: string | null;
}

export type EstimateWarning =
  | { affectedAccountCount: number; code: 'CONNECTION_ATTENTION' }
  | {
      affectedAccountCount: number;
      code: 'INCOMPLETE_HISTORY';
      coverageStatuses: string[];
      earliestKnownDate: BankDate | null;
      requestedFrom: BankDate;
    }
  | { affectedAccountCount: number; code: 'STALE_DATA' }
  | { code: 'UNCONVERTED_CURRENCY'; excludedTransactionCount: number };

export interface AnomalyCandidatesResult {
  asOf: BankDate;
  candidates: AnomalyCandidate[];
  freshness: AnalyticsFreshness;
  policyVersion: number;
  warnings: (
    | EstimateWarning
    | {
        code: 'ESTIMATED_ANOMALIES';
        merchantDeviationPercent: '50';
        categoryDeviationPercent: '50';
        duplicateWindowDays: 2;
        recurringIncreasePercent: '10';
      }
    | { code: 'RESULT_TRUNCATED'; limit: 100 }
  )[];
}

export interface MonthForecastCurrency {
  actualMonthToDate: string;
  commitmentFloorForecast: string;
  confirmedInstallmentsRemaining: string;
  confirmedRecurringRemaining: string;
  currency: string;
  elapsedDays: number;
  forecastTotal: string;
  knownCommitmentsRemaining: string;
  remainingDays: number;
  runRateForecast: string;
  runRateRemaining: string;
  trailingThreeMonthAverage: string;
}

export interface MonthForecastResult {
  asOf: BankDate;
  currencies: MonthForecastCurrency[];
  freshness: AnalyticsFreshness;
  monthEnd: BankDate;
  monthStart: BankDate;
  policyVersion: number;
  warnings: (
    | EstimateWarning
    | {
        code: 'ESTIMATED_FORECAST';
        assumptions: [
          'CURRENT_MONTH_NET_SPENDING_RUN_RATE',
          'CONFIRMED_RECURRING_NEXT_DATES',
          'CONFIRMED_INSTALLMENTS_MONTHLY_FROM_PURCHASE_DATE',
        ];
      }
    | { code: 'COMMITMENTS_NOT_ADDITIVE'; method: 'MAX_RUN_RATE_OR_COMMITMENT_FLOOR' }
  )[];
}

interface WorkspaceContextRow {
  analytics_policy_version: number;
  timezone: string;
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

interface AnomalyRow {
  baseline_value: string | null;
  category_label: string | null;
  currency: string;
  deviation_percent: string | null;
  merchant_label: string | null;
  observed_on: string;
  observed_value: string;
  rule: AnomalyRule;
  threshold_value: string | null;
}

interface ForecastRow {
  actual_month_to_date: string;
  commitment_floor_forecast: string;
  confirmed_installments_remaining: string;
  confirmed_recurring_remaining: string;
  currency: string;
  elapsed_days: number;
  forecast_total: string;
  known_commitments_remaining: string;
  remaining_days: number;
  run_rate_forecast: string;
  run_rate_remaining: string;
  trailing_three_month_average: string;
}

interface AnalyticsContext {
  asOf: BankDate;
  freshness: AnalyticsFreshness;
  policyVersion: number;
  warnings: EstimateWarning[];
}

function requireWorkspaceId(workspaceId: string): void {
  if (workspaceId.trim() !== workspaceId || workspaceId.length === 0 || workspaceId.length > 100) {
    throw new TypeError('workspaceId must contain 1 to 100 trimmed characters.');
  }
}

async function loadContext(
  client: PoolClient,
  workspaceId: string,
  generatedAt: Date,
  range: 'ANOMALY' | 'FORECAST',
): Promise<AnalyticsContext> {
  if (Number.isNaN(generatedAt.getTime())) throw new TypeError('generatedAt must be a valid date.');
  const workspace = await client.query<WorkspaceContextRow>(
    `select analytics_policy_version, timezone from workspace where id = $1`,
    [workspaceId],
  );
  const workspaceRow = workspace.rows[0];
  if (workspaceRow === undefined) throw new Error('Analytics workspace was not found.');
  const asOf = deriveFinancialDate(generatedAt, workspaceRow.timezone);
  const rangeStart = new Date(
    range === 'ANOMALY'
      ? Date.parse(`${asOf}T00:00:00Z`) - 210 * 86_400_000
      : Date.parse(`${asOf.slice(0, 7)}-01T00:00:00Z`),
  );
  if (range === 'FORECAST') rangeStart.setUTCMonth(rangeStart.getUTCMonth() - 3);
  const requestedFrom = parseBankDate(rangeStart.toISOString().slice(0, 10));
  const freshness = await client.query<FreshnessRow>(
    `select max(effective_last_successful_sync_at) as last_successful_sync_at,
       min(effective_last_successful_sync_at) as oldest_account_sync_at,
       coalesce(bool_or(is_stale), false) as is_stale,
       count(*) filter (where is_stale)::integer as stale_count,
       count(*) filter (where requires_connection_attention)::integer as attention_count
     from v_account_data_freshness where workspace_id = $1`,
    [workspaceId],
  );
  const freshnessRow = freshness.rows[0];
  if (freshnessRow === undefined) throw new Error('Analytics freshness query returned no row.');
  const history = await client.query<HistoryRow>(
    `select count(*) filter (
         where provider_history_earliest_date is null or provider_history_earliest_date > $2::date
       )::integer as affected_account_count,
       min(provider_history_earliest_date)::text as earliest_known_date,
       coalesce(array_agg(distinct history_coverage_status) filter (
         where (provider_history_earliest_date is null or provider_history_earliest_date > $2::date)
           and history_coverage_status is not null
       ), '{}'::text[]) as coverage_statuses
     from v_account_history_coverage where workspace_id = $1`,
    [workspaceId, requestedFrom],
  );
  const historyRow = history.rows[0];
  if (historyRow === undefined) throw new Error('Analytics history query returned no row.');
  const warnings: EstimateWarning[] = [];
  if (historyRow.affected_account_count > 0) {
    warnings.push({
      affectedAccountCount: historyRow.affected_account_count,
      code: 'INCOMPLETE_HISTORY',
      coverageStatuses: historyRow.coverage_statuses,
      earliestKnownDate:
        historyRow.earliest_known_date === null
          ? null
          : parseBankDate(historyRow.earliest_known_date),
      requestedFrom,
    });
  }
  if (freshnessRow.stale_count > 0) {
    warnings.push({ affectedAccountCount: freshnessRow.stale_count, code: 'STALE_DATA' });
  }
  if (freshnessRow.attention_count > 0) {
    warnings.push({
      affectedAccountCount: freshnessRow.attention_count,
      code: 'CONNECTION_ATTENTION',
    });
  }
  return {
    asOf,
    freshness: {
      isStale: freshnessRow.is_stale,
      lastSuccessfulSyncAt: freshnessRow.last_successful_sync_at,
      oldestAccountSyncAt: freshnessRow.oldest_account_sync_at,
      staleAfterMinutes: 1440,
    },
    policyVersion: workspaceRow.analytics_policy_version,
    warnings,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original failure.
  }
}

export class AnomalyForecastRepository {
  public constructor(private readonly pool: Pool) {}

  public async anomalies(workspaceId: string, generatedAt: Date): Promise<AnomalyCandidatesResult> {
    requireWorkspaceId(workspaceId);
    const client = await this.pool.connect();
    try {
      await client.query('begin transaction isolation level repeatable read read only');
      const context = await loadContext(client, workspaceId, generatedAt, 'ANOMALY');
      const result = await client.query<AnomalyRow>(
        `with bounds as (
           select $2::date as as_of, date_trunc('month', $2::date)::date as month_start,
             (date_trunc('month', $2::date) + interval '1 month - 1 day')::date as month_end
         ), eligible as (
           select spend.* from v_transaction_spend_effect spend, bounds
           where spend.workspace_id = $1 and spend.status = 'POSTED'
             and spend.deleted_at is null
             and spend.duplicate_review_status <> 'CONFIRMED_DUPLICATE'
             and spend.effective_financial_role = 'PURCHASE'
             and spend.spend_effect_amount > 0 and not spend.has_unconverted_currency
             and spend.transaction_local_date between bounds.as_of - 210 and bounds.as_of
         ), amount_spikes as (
           select 'MERCHANT_AMOUNT_SPIKE'::text as rule, current.transaction_local_date as observed_on,
             current.analytics_currency as currency, current.spend_effect_amount as observed_value,
             baseline.median_amount as baseline_value, baseline.median_amount * 1.50 as threshold_value,
             round((current.spend_effect_amount - baseline.median_amount)
               / baseline.median_amount * 100, 6) as deviation_percent,
             merchant.canonical_name as merchant_label, null::text as category_label, 1 as priority
           from eligible current join bounds on true
           join merchant on merchant.workspace_id = current.workspace_id
             and merchant.id = current.effective_merchant_id and merchant.review_status = 'CONFIRMED'
           cross join lateral (
             select percentile_cont(0.5) within group (order by prior.spend_effect_amount)
               ::numeric(20, 6) as median_amount
             from eligible prior where prior.effective_merchant_id = current.effective_merchant_id
               and prior.analytics_currency = current.analytics_currency
               and (prior.transaction_local_date, prior.id)
                 < (current.transaction_local_date, current.id)
             having count(*) >= 3
           ) baseline
           where current.transaction_local_date >= bounds.month_start
             and baseline.median_amount > 0
             and current.spend_effect_amount > baseline.median_amount * 1.50
         ), duplicate_like as (
           select distinct on (current.id) 'DUPLICATE_LIKE_CHARGE'::text as rule,
             current.transaction_local_date as observed_on, current.analytics_currency as currency,
             current.spend_effect_amount as observed_value,
             prior.spend_effect_amount as baseline_value, prior.spend_effect_amount as threshold_value,
             0::numeric as deviation_percent, merchant.canonical_name as merchant_label,
             null::text as category_label, 2 as priority
           from eligible current join bounds on true
           join eligible prior on prior.effective_merchant_id = current.effective_merchant_id
             and prior.analytics_currency = current.analytics_currency
             and prior.spend_effect_amount = current.spend_effect_amount
             and (prior.transaction_local_date, prior.id) < (current.transaction_local_date, current.id)
             and prior.transaction_local_date >= current.transaction_local_date - 2
           left join merchant on merchant.workspace_id = current.workspace_id
             and merchant.id = current.effective_merchant_id
           where current.transaction_local_date >= bounds.month_start
           order by current.id, prior.transaction_local_date desc, prior.id desc
         ), current_categories as (
           select eligible.effective_category_id as category_id, eligible.analytics_currency as currency,
             sum(eligible.spend_effect_amount) as observed_value
           from eligible, bounds where eligible.transaction_local_date >= bounds.month_start
             and eligible.effective_category_id is not null
           group by eligible.effective_category_id, eligible.analytics_currency
         ), trailing_categories as (
           select monthly.category_id, monthly.currency, sum(monthly.spend_amount) / 3 as baseline_value,
             count(*)::integer as observed_month_count
           from v_monthly_spend_by_category monthly, bounds
           where monthly.workspace_id = $1 and monthly.month >= bounds.month_start - interval '3 months'
             and monthly.month < bounds.month_start and monthly.category_id is not null
           group by monthly.category_id, monthly.currency
         ), category_spikes as (
           select 'CATEGORY_SPEND_SPIKE'::text as rule, bounds.as_of as observed_on,
             current.currency, current.observed_value,
             history.baseline_value * extract(day from bounds.as_of)::numeric
               / extract(day from bounds.month_end)::numeric as baseline_value,
             history.baseline_value * extract(day from bounds.as_of)::numeric
               / extract(day from bounds.month_end)::numeric * 1.50 as threshold_value,
             round((current.observed_value - (history.baseline_value
               * extract(day from bounds.as_of)::numeric / extract(day from bounds.month_end)::numeric))
               / nullif(history.baseline_value * extract(day from bounds.as_of)::numeric
                 / extract(day from bounds.month_end)::numeric, 0) * 100, 6) as deviation_percent,
             null::text as merchant_label, category.name_pt_br as category_label, 3 as priority
           from current_categories current join trailing_categories history using (category_id, currency)
           join category on category.id = current.category_id join bounds on true
           where history.observed_month_count >= 2 and history.baseline_value > 0
             and current.observed_value > history.baseline_value
               * extract(day from bounds.as_of)::numeric
               / extract(day from bounds.month_end)::numeric * 1.50
         ), new_recurring as (
           select 'NEW_RECURRING_MERCHANT'::text as rule, series.last_occurrence_date as observed_on,
             series.currency, series.amount_average as observed_value, null::numeric as baseline_value,
             null::numeric as threshold_value, null::numeric as deviation_percent,
             merchant.canonical_name as merchant_label, category.name_pt_br as category_label,
             4 as priority
           from recurring_series series
           join merchant on merchant.workspace_id = series.workspace_id and merchant.id = series.merchant_id
           left join category on category.id = series.category_id
           join bounds on true
           where series.workspace_id = $1 and series.status = 'CANDIDATE'
             and series.created_at::date between bounds.month_start and bounds.as_of
         ), recurring_increases as (
           select 'RECURRING_AMOUNT_INCREASE'::text as rule,
             latest.transaction_local_date as observed_on, series.currency,
             latest.spend_effect_amount as observed_value, series.amount_average as baseline_value,
             series.amount_average * 1.10 as threshold_value,
             round((latest.spend_effect_amount - series.amount_average)
               / series.amount_average * 100, 6) as deviation_percent,
             merchant.canonical_name as merchant_label, category.name_pt_br as category_label,
             5 as priority
           from recurring_series series
           join merchant on merchant.workspace_id = series.workspace_id and merchant.id = series.merchant_id
           left join category on category.id = series.category_id
           cross join lateral (
             select eligible.transaction_local_date, eligible.spend_effect_amount
             from eligible where eligible.effective_merchant_id = series.merchant_id
               and eligible.analytics_currency = series.currency
             order by eligible.transaction_local_date desc, eligible.id desc limit 1
           ) latest
           join bounds on true
           where series.workspace_id = $1 and series.status = 'CONFIRMED'
             and latest.transaction_local_date >= bounds.month_start
             and series.amount_average > 0 and latest.spend_effect_amount > series.amount_average * 1.10
         ), combined as (
           select * from amount_spikes union all select * from duplicate_like
           union all select * from category_spikes union all select * from new_recurring
           union all select * from recurring_increases
         ) select rule, observed_on::text, currency,
           observed_value::numeric(20, 6)::text, baseline_value::numeric(20, 6)::text,
           threshold_value::numeric(20, 6)::text, deviation_percent::numeric(20, 6)::text,
           merchant_label, category_label from combined
         order by priority, observed_on desc, merchant_label nulls last, category_label nulls last
         limit 101`,
        [workspaceId, context.asOf],
      );
      const unconverted = await client.query<{ count: number }>(
        `select count(*)::integer as count from v_transaction_spend_effect
         where workspace_id = $1 and status = 'POSTED' and deleted_at is null
           and transaction_local_date between $2::date - 210 and $2::date
           and has_unconverted_currency`,
        [workspaceId, context.asOf],
      );
      const selected = result.rows.slice(0, 100);
      const warnings: AnomalyCandidatesResult['warnings'] = [
        {
          categoryDeviationPercent: '50',
          code: 'ESTIMATED_ANOMALIES',
          duplicateWindowDays: 2,
          merchantDeviationPercent: '50',
          recurringIncreasePercent: '10',
        },
        ...context.warnings,
      ];
      const unconvertedCount = unconverted.rows[0]?.count ?? 0;
      if (unconvertedCount > 0) {
        warnings.push({ code: 'UNCONVERTED_CURRENCY', excludedTransactionCount: unconvertedCount });
      }
      if (result.rows.length > 100) warnings.push({ code: 'RESULT_TRUNCATED', limit: 100 });
      await client.query('commit');
      return {
        asOf: context.asOf,
        candidates: selected.map((row) => ({
          baselineValue: row.baseline_value,
          categoryLabel: row.category_label,
          currency: row.currency,
          deviationPercent: row.deviation_percent,
          merchantLabel: row.merchant_label,
          observedOn: parseBankDate(row.observed_on),
          observedValue: row.observed_value,
          rule: row.rule,
          status: 'CANDIDATE',
          thresholdValue: row.threshold_value,
        })),
        freshness: context.freshness,
        policyVersion: context.policyVersion,
        warnings,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async forecast(workspaceId: string, generatedAt: Date): Promise<MonthForecastResult> {
    requireWorkspaceId(workspaceId);
    const client = await this.pool.connect();
    try {
      await client.query('begin transaction isolation level repeatable read read only');
      const context = await loadContext(client, workspaceId, generatedAt, 'FORECAST');
      const result = await client.query<ForecastRow>(
        `with bounds as (
           select $2::date as as_of, date_trunc('month', $2::date)::date as month_start,
             (date_trunc('month', $2::date) + interval '1 month - 1 day')::date as month_end
         ), mtd as (
           select spend.analytics_currency as currency,
             coalesce(sum(spend.spend_effect_amount), 0::numeric) as amount
           from v_transaction_spend_effect spend, bounds
           where spend.workspace_id = $1 and spend.status = 'POSTED' and spend.deleted_at is null
             and spend.duplicate_review_status <> 'CONFIRMED_DUPLICATE'
             and not spend.has_unconverted_currency
             and spend.transaction_local_date between bounds.month_start and bounds.as_of
           group by spend.analytics_currency
         ), recurring as (
           select series.currency, sum(series.amount_average)::numeric as amount
           from recurring_series series, bounds
           cross join lateral generate_series(
             series.next_expected_date, bounds.month_end,
             make_interval(days => series.expected_interval_days)
           ) occurrence
           where series.workspace_id = $1 and series.status = 'CONFIRMED'
             and series.next_expected_date > bounds.as_of
             and series.next_expected_date <= bounds.month_end
           group by series.currency
         ), installments as (
           select commitment.currency, sum(commitment.estimated_installment_amount) as amount
           from v_installment_commitments commitment, bounds
           where commitment.workspace_id = $1 and commitment.status = 'CONFIRMED'
             and commitment.remaining_installments > 0
             and commitment.estimated_installment_amount is not null
             and commitment.purchase_date is not null
             and (date_trunc('month', commitment.purchase_date)::date
               + make_interval(months => commitment.highest_confirmed_installment))::date
               = bounds.month_start
           group by commitment.currency
         ), trailing_average as (
           select monthly.currency, sum(monthly.spend_amount) / 3 as amount
           from v_monthly_spend_by_category monthly, bounds
           where monthly.workspace_id = $1
             and monthly.month >= bounds.month_start - interval '3 months'
             and monthly.month < bounds.month_start
           group by monthly.currency
         ), currencies as (
           select currency from mtd union select currency from recurring
           union select currency from installments union select currency from trailing_average
         ), components as (
           select currencies.currency, coalesce(mtd.amount, 0::numeric) as actual,
             coalesce(recurring.amount, 0::numeric) as recurring,
             coalesce(installments.amount, 0::numeric) as installments,
             coalesce(trailing_average.amount, 0::numeric) as trailing_amount,
             extract(day from bounds.as_of)::integer as elapsed_days,
             extract(day from bounds.month_end)::integer as days_in_month
           from currencies cross join bounds left join mtd using (currency)
           left join recurring using (currency) left join installments using (currency)
           left join trailing_average using (currency)
         ) select currency, elapsed_days,
           (days_in_month - elapsed_days)::integer as remaining_days,
           actual::numeric(20, 6)::text as actual_month_to_date,
           (actual / elapsed_days * (days_in_month - elapsed_days))
             ::numeric(20, 6)::text as run_rate_remaining,
           (actual / elapsed_days * days_in_month)::numeric(20, 6)::text as run_rate_forecast,
           recurring::numeric(20, 6)::text as confirmed_recurring_remaining,
           installments::numeric(20, 6)::text as confirmed_installments_remaining,
           (recurring + installments)::numeric(20, 6)::text as known_commitments_remaining,
           (actual + recurring + installments)::numeric(20, 6)::text as commitment_floor_forecast,
           greatest(actual / elapsed_days * days_in_month, actual + recurring + installments)
             ::numeric(20, 6)::text as forecast_total,
           trailing_amount::numeric(20, 6)::text as trailing_three_month_average
         from components order by currency`,
        [workspaceId, context.asOf],
      );
      const unconverted = await client.query<{ count: number }>(
        `select count(*)::integer as count from v_transaction_spend_effect, (
           select date_trunc('month', $2::date)::date as month_start
         ) bounds where workspace_id = $1 and status = 'POSTED' and deleted_at is null
           and transaction_local_date between bounds.month_start - interval '3 months' and $2::date
           and has_unconverted_currency`,
        [workspaceId, context.asOf],
      );
      const monthBounds = await client.query<{ month_end: string; month_start: string }>(
        `select date_trunc('month', $1::date)::date::text as month_start,
           (date_trunc('month', $1::date) + interval '1 month - 1 day')::date::text as month_end`,
        [context.asOf],
      );
      const bounds = monthBounds.rows[0];
      if (bounds === undefined) throw new Error('Forecast bounds query returned no row.');
      const warnings: MonthForecastResult['warnings'] = [
        {
          assumptions: [
            'CURRENT_MONTH_NET_SPENDING_RUN_RATE',
            'CONFIRMED_RECURRING_NEXT_DATES',
            'CONFIRMED_INSTALLMENTS_MONTHLY_FROM_PURCHASE_DATE',
          ],
          code: 'ESTIMATED_FORECAST',
        },
        { code: 'COMMITMENTS_NOT_ADDITIVE', method: 'MAX_RUN_RATE_OR_COMMITMENT_FLOOR' },
        ...context.warnings,
      ];
      const unconvertedCount = unconverted.rows[0]?.count ?? 0;
      if (unconvertedCount > 0) {
        warnings.push({ code: 'UNCONVERTED_CURRENCY', excludedTransactionCount: unconvertedCount });
      }
      await client.query('commit');
      return {
        asOf: context.asOf,
        currencies: result.rows.map((row) => ({
          actualMonthToDate: row.actual_month_to_date,
          commitmentFloorForecast: row.commitment_floor_forecast,
          confirmedInstallmentsRemaining: row.confirmed_installments_remaining,
          confirmedRecurringRemaining: row.confirmed_recurring_remaining,
          currency: row.currency,
          elapsedDays: row.elapsed_days,
          forecastTotal: row.forecast_total,
          knownCommitmentsRemaining: row.known_commitments_remaining,
          remainingDays: row.remaining_days,
          runRateForecast: row.run_rate_forecast,
          runRateRemaining: row.run_rate_remaining,
          trailingThreeMonthAverage: row.trailing_three_month_average,
        })),
        freshness: context.freshness,
        monthEnd: parseBankDate(bounds.month_end),
        monthStart: parseBankDate(bounds.month_start),
        policyVersion: context.policyVersion,
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
