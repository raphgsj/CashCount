import type { Pool, PoolClient } from 'pg';

export type RecurringCadence = 'ANNUAL' | 'CUSTOM' | 'MONTHLY' | 'QUARTERLY' | 'WEEKLY';
export type RecurringStatus = 'CANDIDATE' | 'CONFIRMED' | 'ENDED' | 'REJECTED';

export interface RecurringSeriesRecord {
  amountAverage: string;
  amountMax: string;
  amountMin: string;
  cadence: RecurringCadence;
  confidence: string;
  currency: string;
  expectedIntervalDays: number;
  id: string;
  lastOccurrenceDate: string;
  merchantLabel: string;
  nextExpectedDate: string | null;
  observationCount: number;
  priceChangePercent: string | null;
  status: RecurringStatus;
}

export interface RecurringSeriesResult {
  freshness: {
    isStale: boolean;
    lastSuccessfulSyncAt: Date | null;
    oldestAccountSyncAt: Date | null;
    staleAfterMinutes: 1440;
  };
  monthlyBaseline: { currency: string; value: string }[];
  policyVersion: number;
  series: RecurringSeriesRecord[];
  warnings: (
    | { affectedAccountCount: number; code: 'CONNECTION_ATTENTION' }
    | { affectedAccountCount: number; code: 'STALE_DATA' }
    | { assumption: 'CADENCE_NORMALIZED_MONTHLY'; code: 'ESTIMATED_RECURRING_BASELINE' }
  )[];
}

interface RecurringRow {
  amount_average: string;
  amount_max: string;
  amount_min: string;
  cadence: RecurringCadence;
  confidence: string;
  currency: string;
  expected_interval_days: number;
  id: string;
  last_occurrence_date: string;
  merchant_label: string;
  next_expected_date: string | null;
  observation_count: number;
  price_change_percent: string | null;
  status: RecurringStatus;
}

function record(row: RecurringRow): RecurringSeriesRecord {
  return {
    amountAverage: row.amount_average,
    amountMax: row.amount_max,
    amountMin: row.amount_min,
    cadence: row.cadence,
    confidence: row.confidence,
    currency: row.currency,
    expectedIntervalDays: row.expected_interval_days,
    id: row.id,
    lastOccurrenceDate: row.last_occurrence_date,
    merchantLabel: row.merchant_label,
    nextExpectedDate: row.next_expected_date,
    observationCount: row.observation_count,
    priceChangePercent: row.price_change_percent,
    status: row.status,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original failure.
  }
}

export class RecurringSeriesNotFoundError extends Error {
  public constructor() {
    super('The recurring series was not found.');
    this.name = 'RecurringSeriesNotFoundError';
  }
}

export class RecurringSeriesConflictError extends Error {
  public constructor() {
    super('The recurring series is no longer actionable.');
    this.name = 'RecurringSeriesConflictError';
  }
}

export class RecurringRepository {
  public constructor(private readonly pool: Pool) {}

  public async detect(workspaceId: string, actorId: string): Promise<{ candidateCount: number }> {
    if (actorId.trim() !== actorId || actorId.length === 0 || actorId.length > 200) {
      throw new TypeError('actorId must contain 1 to 200 trimmed characters.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 680000))`, [
        workspaceId,
      ]);
      const detected = await client.query<{ id: string }>(
        `with observations as (
           select spend.effective_merchant_id as merchant_id,
             spend.effective_category_id as category_id, spend.analytics_currency as currency,
             spend.transaction_local_date, spend.spend_effect_amount,
             lag(spend.transaction_local_date) over (
               partition by spend.effective_merchant_id, spend.analytics_currency
               order by spend.transaction_local_date, spend.id
             ) as previous_date
           from v_transaction_spend_effect spend
           join merchant on merchant.workspace_id = spend.workspace_id
             and merchant.id = spend.effective_merchant_id
             and merchant.review_status = 'CONFIRMED'
           where spend.workspace_id = $1 and spend.status = 'POSTED'
             and spend.deleted_at is null
             and spend.duplicate_review_status <> 'CONFIRMED_DUPLICATE'
             and spend.effective_financial_role = 'PURCHASE'
             and spend.spend_effect_amount > 0 and not spend.has_unconverted_currency
             and spend.transaction_local_date >= current_date - 730
         ), interval_stats as (
           select merchant_id, currency,
             percentile_cont(0.5) within group (
               order by transaction_local_date - previous_date
             ) as median_interval
           from observations where previous_date is not null group by merchant_id, currency
         ), grouped as (
           select observations.merchant_id, observations.currency,
             count(*)::integer as observation_count,
             case when count(distinct category_id) = 1
               then min(category_id::text)::uuid else null end as category_id,
             min(spend_effect_amount)::numeric(20, 6) as amount_min,
             max(spend_effect_amount)::numeric(20, 6) as amount_max,
             avg(spend_effect_amount)::numeric(20, 6) as amount_average,
             max(transaction_local_date) as last_occurrence_date,
             interval_stats.median_interval,
             max(abs((transaction_local_date - previous_date)
               - interval_stats.median_interval)) filter (where previous_date is not null)
               as maximum_interval_deviation
           from observations join interval_stats using (merchant_id, currency)
           group by observations.merchant_id, observations.currency,
             interval_stats.median_interval having count(*) >= 3
         ), classified as (
           select *, case
             when median_interval between 6 and 8 and maximum_interval_deviation <= 3 then 'WEEKLY'
             when median_interval between 26 and 35 and maximum_interval_deviation <= 6 then 'MONTHLY'
             when median_interval between 80 and 100 and maximum_interval_deviation <= 12 then 'QUARTERLY'
             when median_interval between 350 and 380 and maximum_interval_deviation <= 25 then 'ANNUAL'
             else null end as cadence
           from grouped where amount_average > 0
             and (amount_max - amount_min) / amount_average <= 0.20
         ), eligible as (
           select *, round(median_interval)::integer as expected_interval_days,
             least(0.9900, greatest(0.5000,
               1 - ((amount_max - amount_min) / amount_average)
                 - (maximum_interval_deviation / greatest(median_interval, 1)) * 0.25
             ))::numeric(5, 4) as confidence
           from classified where cadence is not null
         ), inserted as (
           insert into recurring_series (
             workspace_id, merchant_id, category_id, cadence, expected_interval_days,
             currency, amount_min, amount_max, amount_average, last_occurrence_date,
             next_expected_date, confidence, status
           )
           select $1, eligible.merchant_id, eligible.category_id, eligible.cadence,
             eligible.expected_interval_days, eligible.currency, eligible.amount_min,
             eligible.amount_max, eligible.amount_average, eligible.last_occurrence_date,
             eligible.last_occurrence_date + eligible.expected_interval_days,
             eligible.confidence, 'CANDIDATE'
           from eligible where not exists (
             select 1 from recurring_series existing where existing.workspace_id = $1
               and existing.merchant_id = eligible.merchant_id
               and existing.currency = eligible.currency and existing.cadence = eligible.cadence
           ) returning id
         ) select id from inserted`,
        [workspaceId],
      );
      if (detected.rows.length > 0) {
        await client.query(
          `insert into audit_event (
             workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
           ) values ($1::uuid, 'USER', $2, 'RECURRING_DETECTION_RUN', 'WORKSPACE',
             $1::uuid::text,
             jsonb_build_object('candidateCount', $3::integer))`,
          [workspaceId, actorId, detected.rows.length],
        );
      }
      await client.query('commit');
      return { candidateCount: detected.rows.length };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async list(workspaceId: string, includeInactive = false): Promise<RecurringSeriesResult> {
    const result = await this.pool.query<RecurringRow>(
      `select series.id, series.cadence, series.expected_interval_days,
         series.currency, series.amount_min::numeric(20, 6)::text,
         series.amount_max::numeric(20, 6)::text,
         series.amount_average::numeric(20, 6)::text,
         series.last_occurrence_date::text, series.next_expected_date::text,
         series.confidence::text, series.status, merchant.canonical_name as merchant_label,
         coalesce(observations.observation_count, 0)::integer as observation_count,
         case when series.amount_average = 0 or observations.latest_amount is null then null
           else round((observations.latest_amount - series.amount_average)
             / series.amount_average * 100, 6)::text end as price_change_percent
       from recurring_series series
       join merchant on merchant.workspace_id = series.workspace_id and merchant.id = series.merchant_id
       left join lateral (
         select count(*)::integer as observation_count,
           (array_agg(spend.spend_effect_amount order by spend.transaction_local_date desc, spend.id desc))[1]
             as latest_amount
         from v_transaction_spend_effect spend
         where spend.workspace_id = series.workspace_id
           and spend.effective_merchant_id = series.merchant_id
           and spend.analytics_currency = series.currency and spend.status = 'POSTED'
           and spend.deleted_at is null
           and spend.duplicate_review_status <> 'CONFIRMED_DUPLICATE'
           and spend.effective_financial_role = 'PURCHASE' and spend.spend_effect_amount > 0
       ) observations on true
       where series.workspace_id = $1
         and ($2::boolean or series.status in ('CANDIDATE', 'CONFIRMED'))
       order by case series.status when 'CONFIRMED' then 0 when 'CANDIDATE' then 1 else 2 end,
         series.next_expected_date nulls last, series.id limit 100`,
      [workspaceId, includeInactive],
    );
    const baseline = await this.pool.query<{ currency: string; value: string }>(
      `select currency,
         sum(case cadence when 'WEEKLY' then amount_average * 4.348214
           when 'MONTHLY' then amount_average when 'QUARTERLY' then amount_average / 3
           when 'ANNUAL' then amount_average / 12
           else amount_average * 30.4375 / expected_interval_days end)
           ::numeric(20, 6)::text as value
       from recurring_series where workspace_id = $1 and status = 'CONFIRMED'
       group by currency order by currency`,
      [workspaceId],
    );
    const workspace = await this.pool.query<{ analytics_policy_version: number }>(
      `select analytics_policy_version from workspace where id = $1`,
      [workspaceId],
    );
    const policy = workspace.rows[0];
    if (policy === undefined) throw new RecurringSeriesNotFoundError();
    const freshness = await this.pool.query<{
      attention_count: number;
      is_stale: boolean;
      last_successful_sync_at: Date | null;
      oldest_account_sync_at: Date | null;
      stale_count: number;
    }>(
      `select max(effective_last_successful_sync_at) as last_successful_sync_at,
         min(effective_last_successful_sync_at) as oldest_account_sync_at,
         coalesce(bool_or(is_stale), false) as is_stale,
         count(*) filter (where is_stale)::integer as stale_count,
         count(*) filter (where requires_connection_attention)::integer as attention_count
       from v_account_data_freshness where workspace_id = $1`,
      [workspaceId],
    );
    const freshnessRow = freshness.rows[0];
    if (freshnessRow === undefined) throw new Error('Recurring freshness query returned no row.');
    const warnings: RecurringSeriesResult['warnings'] = [];
    if (baseline.rows.length > 0) {
      warnings.push({
        assumption: 'CADENCE_NORMALIZED_MONTHLY',
        code: 'ESTIMATED_RECURRING_BASELINE',
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
      freshness: {
        isStale: freshnessRow.is_stale,
        lastSuccessfulSyncAt: freshnessRow.last_successful_sync_at,
        oldestAccountSyncAt: freshnessRow.oldest_account_sync_at,
        staleAfterMinutes: 1440,
      },
      monthlyBaseline: baseline.rows,
      policyVersion: policy.analytics_policy_version,
      series: result.rows.map(record),
      warnings,
    };
  }

  public async resolve(
    workspaceId: string,
    seriesId: string,
    actorId: string,
    status: 'CONFIRMED' | 'REJECTED',
  ): Promise<void> {
    if (actorId.trim() !== actorId || actorId.length === 0 || actorId.length > 200) {
      throw new TypeError('actorId must contain 1 to 200 trimmed characters.');
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const updated = await client.query<{ id: string }>(
        `update recurring_series set status = $3, updated_at = now()
         where workspace_id = $1 and id = $2 and status = 'CANDIDATE'
         returning id`,
        [workspaceId, seriesId, status],
      );
      if (updated.rows[0] === undefined) {
        const existing = await client.query<{ status: RecurringStatus }>(
          `select status from recurring_series where workspace_id = $1 and id = $2 for update`,
          [workspaceId, seriesId],
        );
        const existingStatus = existing.rows[0]?.status;
        if (existingStatus === undefined) throw new RecurringSeriesNotFoundError();
        if (existingStatus === status) {
          await client.query('commit');
          return;
        }
        throw new RecurringSeriesConflictError();
      }
      await client.query(
        `insert into audit_event (
           workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
         ) values ($1, 'USER', $2, $3, 'RECURRING_SERIES', $4, '{}')`,
        [
          workspaceId,
          actorId,
          status === 'CONFIRMED' ? 'RECURRING_SERIES_CONFIRMED' : 'RECURRING_SERIES_REJECTED',
          seriesId,
        ],
      );
      await client.query('commit');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
