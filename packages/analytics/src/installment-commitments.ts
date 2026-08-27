import type { Pool } from 'pg';

import { parseBankDate, type BankDate } from '@cashcount/domain';

export interface InstallmentCommitmentsInput {
  cardId?: string;
  includeReviewStates?: boolean;
}

export interface InstallmentCommitmentSeries {
  currency: string;
  estimatedInstallmentAmount: string | null;
  estimatedNextMonth: BankDate | null;
  estimatedRemainingCommitment: string | null;
  highestConfirmedInstallment: number;
  merchantLabel: string | null;
  originalTotalAmount: string | null;
  purchaseDate: BankDate | null;
  remainingInstallments: number;
  status: 'CANDIDATE' | 'COMPLETED' | 'CONFIRMED' | 'NEEDS_REVIEW';
  totalInstallments: number;
}

export interface MonthlyInstallmentCommitment {
  currency: string;
  estimatedAmount: string;
  estimatedInstallmentCount: number;
  month: BankDate;
}

export type InstallmentCommitmentWarning =
  | { code: 'CONNECTION_ATTENTION'; affectedAccountCount: number }
  | { code: 'ESTIMATED_COMMITMENTS'; assumption: 'MONTHLY_FROM_PURCHASE_DATE' }
  | { code: 'SERIES_TRUNCATED'; limit: 100 }
  | { code: 'STALE_DATA'; affectedAccountCount: number }
  | { code: 'UNALLOCATED_INSTALLMENTS'; affectedSeriesCount: number }
  | { code: 'UNCONVERTED_CURRENCY'; excludedTransactionCount: number };

export interface InstallmentCommitmentsResult {
  freshness: {
    isStale: boolean;
    lastSuccessfulSyncAt: Date | null;
    oldestAccountSyncAt: Date | null;
    staleAfterMinutes: 1440;
  };
  includeReviewStates: boolean;
  monthly: MonthlyInstallmentCommitment[];
  policyVersion: number;
  series: InstallmentCommitmentSeries[];
  warnings: InstallmentCommitmentWarning[];
}

interface SeriesRow {
  currency: string;
  estimated_installment_amount: string | null;
  estimated_next_month: string | null;
  estimated_remaining_commitment: string | null;
  highest_confirmed_installment: number;
  merchant_label: string | null;
  original_total_amount: string | null;
  purchase_date: string | null;
  remaining_installments: number;
  status: InstallmentCommitmentSeries['status'];
  total_installments: number;
  unconverted_transaction_count: number;
}

interface MonthlyRow {
  currency: string;
  estimated_amount: string;
  estimated_installment_count: number;
  month: string;
}

interface ContextRow {
  analytics_policy_version: number;
  attention_count: number;
  is_stale: boolean;
  last_successful_sync_at: Date | null;
  oldest_account_sync_at: Date | null;
  stale_count: number;
}

function requireUuid(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError('cardId must be a UUID.');
  }
}

export class InstallmentCommitmentsRepository {
  public constructor(private readonly pool: Pool) {}

  public async list(
    workspaceId: string,
    input: InstallmentCommitmentsInput = {},
  ): Promise<InstallmentCommitmentsResult> {
    if (
      workspaceId.trim() !== workspaceId ||
      workspaceId.length === 0 ||
      workspaceId.length > 100
    ) {
      throw new TypeError('workspaceId must contain 1 to 100 trimmed characters.');
    }
    if (input.cardId !== undefined) requireUuid(input.cardId);
    const cardId = input.cardId ?? null;
    const includeReviewStates = input.includeReviewStates ?? false;
    const client = await this.pool.connect();
    try {
      await client.query('begin transaction isolation level repeatable read read only');
      const seriesResult = await client.query<SeriesRow>(
        `select commitment.currency, commitment.total_installments,
           commitment.highest_confirmed_installment, commitment.remaining_installments,
           commitment.estimated_installment_amount::numeric(20, 6)::text,
           commitment.original_total_amount::numeric(20, 6)::text,
           commitment.estimated_remaining_commitment::numeric(20, 6)::text,
           commitment.purchase_date::text, commitment.status,
           commitment.unconverted_transaction_count::integer,
           merchant.canonical_name as merchant_label,
           case when commitment.purchase_date is null or commitment.remaining_installments = 0
             then null else (
               date_trunc('month', commitment.purchase_date)::date
               + make_interval(months => commitment.highest_confirmed_installment)
             )::date::text end as estimated_next_month
         from v_installment_commitments commitment
         left join merchant on merchant.workspace_id = commitment.workspace_id
           and merchant.id = commitment.merchant_id
         where commitment.workspace_id = $1
           and ($2::uuid is null or commitment.financial_account_id = $2)
           and (($3::boolean and commitment.status in (
             'CANDIDATE', 'CONFIRMED', 'NEEDS_REVIEW', 'COMPLETED'
           )) or (not $3::boolean and commitment.status = 'CONFIRMED'
             and commitment.remaining_installments > 0))
         order by case commitment.status when 'CONFIRMED' then 0 when 'NEEDS_REVIEW' then 1
           when 'CANDIDATE' then 2 else 3 end,
           commitment.purchase_date desc nulls last, commitment.installment_series_id
         limit 101`,
        [workspaceId, cardId, includeReviewStates],
      );

      const monthlyResult = await client.query<MonthlyRow>(
        `with projected as (
           select commitment.currency, commitment.estimated_installment_amount,
             (date_trunc('month', commitment.purchase_date)::date
               + make_interval(months => installment_number))::date as month
           from v_installment_commitments commitment
           cross join lateral generate_series(
             commitment.highest_confirmed_installment,
             commitment.total_installments - 1
           ) installment_number
           where commitment.workspace_id = $1
             and ($2::uuid is null or commitment.financial_account_id = $2)
             and commitment.status = 'CONFIRMED' and commitment.remaining_installments > 0
             and commitment.estimated_installment_amount is not null
             and commitment.purchase_date is not null
         )
         select month::text, currency,
           sum(estimated_installment_amount)::numeric(20, 6)::text as estimated_amount,
           count(*)::integer as estimated_installment_count
         from projected group by month, currency order by month, currency
         limit 1200`,
        [workspaceId, cardId],
      );

      const contextResult = await client.query<ContextRow>(
        `select workspace.analytics_policy_version,
           max(freshness.effective_last_successful_sync_at) as last_successful_sync_at,
           min(freshness.effective_last_successful_sync_at) as oldest_account_sync_at,
           coalesce(bool_or(freshness.is_stale), false) as is_stale,
           count(*) filter (where freshness.is_stale)::integer as stale_count,
           count(*) filter (where freshness.requires_connection_attention)::integer as attention_count
         from workspace
         left join v_account_data_freshness freshness on freshness.workspace_id = workspace.id
           and ($2::uuid is null or freshness.financial_account_id = $2)
         where workspace.id = $1
         group by workspace.analytics_policy_version`,
        [workspaceId, cardId],
      );
      const context = contextResult.rows[0];
      if (context === undefined) throw new Error('Installment workspace was not found.');

      const selected = seriesResult.rows.slice(0, 100);
      const warnings: InstallmentCommitmentWarning[] = [];
      if (selected.some((row) => row.status === 'CONFIRMED' && row.remaining_installments > 0)) {
        warnings.push({ code: 'ESTIMATED_COMMITMENTS', assumption: 'MONTHLY_FROM_PURCHASE_DATE' });
      }
      const unallocated = selected.filter(
        (row) =>
          row.status === 'CONFIRMED' &&
          row.remaining_installments > 0 &&
          (row.estimated_installment_amount === null || row.purchase_date === null),
      ).length;
      if (unallocated > 0) {
        warnings.push({ affectedSeriesCount: unallocated, code: 'UNALLOCATED_INSTALLMENTS' });
      }
      const unconverted = selected.reduce(
        (count, row) => count + row.unconverted_transaction_count,
        0,
      );
      if (unconverted > 0) {
        warnings.push({ code: 'UNCONVERTED_CURRENCY', excludedTransactionCount: unconverted });
      }
      if (context.stale_count > 0) {
        warnings.push({ affectedAccountCount: context.stale_count, code: 'STALE_DATA' });
      }
      if (context.attention_count > 0) {
        warnings.push({
          affectedAccountCount: context.attention_count,
          code: 'CONNECTION_ATTENTION',
        });
      }
      if (seriesResult.rows.length > 100) warnings.push({ code: 'SERIES_TRUNCATED', limit: 100 });

      await client.query('commit');
      return {
        freshness: {
          isStale: context.is_stale,
          lastSuccessfulSyncAt: context.last_successful_sync_at,
          oldestAccountSyncAt: context.oldest_account_sync_at,
          staleAfterMinutes: 1440,
        },
        includeReviewStates,
        monthly: monthlyResult.rows.map((row) => ({
          currency: row.currency,
          estimatedAmount: row.estimated_amount,
          estimatedInstallmentCount: row.estimated_installment_count,
          month: parseBankDate(row.month),
        })),
        policyVersion: context.analytics_policy_version,
        series: selected.map((row) => ({
          currency: row.currency,
          estimatedInstallmentAmount: row.estimated_installment_amount,
          estimatedNextMonth:
            row.estimated_next_month === null ? null : parseBankDate(row.estimated_next_month),
          estimatedRemainingCommitment: row.estimated_remaining_commitment,
          highestConfirmedInstallment: row.highest_confirmed_installment,
          merchantLabel: row.merchant_label,
          originalTotalAmount: row.original_total_amount,
          purchaseDate: row.purchase_date === null ? null : parseBankDate(row.purchase_date),
          remainingInstallments: row.remaining_installments,
          status: row.status,
          totalInstallments: row.total_installments,
        })),
        warnings,
      };
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        // Preserve the original failure.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
