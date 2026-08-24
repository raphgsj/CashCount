import type { Pool } from 'pg';

import { parseBankDate, type BankDate } from '@cashcount/domain';

export const classificationQualitySources = [
  'USER',
  'RULE',
  'MERCHANT',
  'HEURISTIC',
  'PROVIDER',
  'MODEL',
  'UNATTRIBUTED',
  'UNCLASSIFIED',
] as const;

export type ClassificationQualitySource = (typeof classificationQualitySources)[number];

export interface ClassificationQualitySourceDistribution {
  count: number;
  percentage: string;
  source: ClassificationQualitySource;
}

export interface ClassificationQualityReport {
  classifiedCount: number;
  sourceDistribution: readonly ClassificationQualitySourceDistribution[];
  totalCount: number;
  unclassifiedCount: number;
  unclassifiedPercentage: string;
  workspaceId: string;
}

export interface UnclassifiedQueueCursor {
  id: string;
  transactionLocalDate: BankDate;
}

export interface UnclassifiedQueueItem {
  accountCurrency: string;
  accountCurrencyAmountSigned: string | null;
  categorySource: string;
  descriptionNormalized: string;
  descriptionOriginal: string;
  financialAccountId: string;
  financialRole: string;
  hasUnconvertedCurrency: boolean;
  id: string;
  merchantId: string | null;
  merchantName: string | null;
  providerCategoryName: string | null;
  transactionLocalDate: BankDate;
  userReviewStatus: string;
}

export interface UnclassifiedQueuePage {
  items: readonly UnclassifiedQueueItem[];
  nextCursor: UnclassifiedQueueCursor | null;
}

export interface ListUnclassifiedQueueInput {
  cursor?: UnclassifiedQueueCursor;
  limit?: number;
}

interface QualityRow {
  classified_count: number;
  count: number;
  percentage: string;
  source: ClassificationQualitySource;
  total_count: number;
  unclassified_count: number;
  unclassified_percentage: string;
}

interface QueueRow {
  account_currency: string;
  account_currency_amount_signed: string | null;
  category_source: string;
  description_normalized: string;
  description_original: string;
  financial_account_id: string;
  financial_role: string;
  has_unconverted_currency: boolean;
  id: string;
  merchant_id: string | null;
  merchant_name: string | null;
  provider_category_name: string | null;
  transaction_local_date: string;
  user_review_status: string;
}

function requireWorkspaceId(workspaceId: string): void {
  if (workspaceId.trim() !== workspaceId || workspaceId.length === 0 || workspaceId.length > 100) {
    throw new TypeError('workspaceId must contain 1 to 100 trimmed characters.');
  }
}

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Unclassified queue limit must be an integer from 1 to 100.');
  }
}

function requireUuid(name: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError(`${name} must be a UUID.`);
  }
}

function queueItem(row: QueueRow): UnclassifiedQueueItem {
  return {
    accountCurrency: row.account_currency,
    accountCurrencyAmountSigned: row.account_currency_amount_signed,
    categorySource: row.category_source,
    descriptionNormalized: row.description_normalized,
    descriptionOriginal: row.description_original,
    financialAccountId: row.financial_account_id,
    financialRole: row.financial_role,
    hasUnconvertedCurrency: row.has_unconverted_currency,
    id: row.id,
    merchantId: row.merchant_id,
    merchantName: row.merchant_name,
    providerCategoryName: row.provider_category_name,
    transactionLocalDate: parseBankDate(row.transaction_local_date),
    userReviewStatus: row.user_review_status,
  };
}

export class ClassificationQualityRepository {
  public constructor(private readonly pool: Pool) {}

  public async getReport(workspaceId: string): Promise<ClassificationQualityReport> {
    requireWorkspaceId(workspaceId);
    const result = await this.pool.query<QualityRow>(
      `with source_order(source, ordinal) as (
         values ('USER', 1), ('RULE', 2), ('MERCHANT', 3), ('HEURISTIC', 4),
                ('PROVIDER', 5), ('MODEL', 6), ('UNATTRIBUTED', 7),
                ('UNCLASSIFIED', 8)
       ), eligible as (
         select effective_category_id, effective_category_source
         from v_financial_transaction_effective
         where workspace_id = $1 and deleted_at is null and status <> 'DELETED'
       ), bucketed as (
         select case
           when effective_category_id is null then 'UNCLASSIFIED'
           when effective_category_source in
             ('USER', 'RULE', 'MERCHANT', 'HEURISTIC', 'PROVIDER', 'MODEL')
             then effective_category_source
           else 'UNATTRIBUTED'
         end as source
         from eligible
       ), counts as (
         select source, count(*)::integer as count from bucketed group by source
       ), totals as (
         select count(*)::integer as total_count,
                count(*) filter (where effective_category_id is not null)::integer
                  as classified_count,
                count(*) filter (where effective_category_id is null)::integer
                  as unclassified_count
         from eligible
       )
       select source_order.source, coalesce(counts.count, 0)::integer as count,
              coalesce(
                round(coalesce(counts.count, 0)::numeric * 100
                  / nullif(totals.total_count, 0), 4), 0
              )::numeric(7, 4)::text as percentage,
              totals.total_count, totals.classified_count, totals.unclassified_count,
              coalesce(
                round(totals.unclassified_count::numeric * 100
                  / nullif(totals.total_count, 0), 4), 0
              )::numeric(7, 4)::text as unclassified_percentage
       from source_order
       cross join totals
       left join counts on counts.source = source_order.source
       order by source_order.ordinal`,
      [workspaceId],
    );
    const first = result.rows[0];
    if (first === undefined) {
      throw new Error('Classification quality query did not return its fixed source buckets.');
    }
    return {
      classifiedCount: first.classified_count,
      sourceDistribution: result.rows.map((row) => ({
        count: row.count,
        percentage: row.percentage,
        source: row.source,
      })),
      totalCount: first.total_count,
      unclassifiedCount: first.unclassified_count,
      unclassifiedPercentage: first.unclassified_percentage,
      workspaceId,
    };
  }

  public async listUnclassified(
    workspaceId: string,
    input: ListUnclassifiedQueueInput = {},
  ): Promise<UnclassifiedQueuePage> {
    requireWorkspaceId(workspaceId);
    const limit = input.limit ?? 50;
    requireLimit(limit);
    const cursorDate =
      input.cursor === undefined ? null : parseBankDate(input.cursor.transactionLocalDate);
    const cursorId = input.cursor?.id ?? null;
    if (cursorId !== null) requireUuid('cursor.id', cursorId);

    const result = await this.pool.query<QueueRow>(
      `select unclassified.id, unclassified.financial_account_id,
              unclassified.analytics_currency as account_currency,
              unclassified.analytics_amount_signed::text as account_currency_amount_signed,
              unclassified.description_original, unclassified.description_normalized,
              unclassified.transaction_local_date::text,
              unclassified.effective_category_source as category_source,
              unclassified.effective_financial_role as financial_role,
              unclassified.has_unconverted_currency,
              unclassified.effective_merchant_id as merchant_id,
              merchant.canonical_name as merchant_name,
              unclassified.provider_category_name,
              unclassified.user_review_status
       from v_unclassified_transactions unclassified
       left join merchant
         on merchant.workspace_id = unclassified.workspace_id
        and merchant.id = unclassified.effective_merchant_id
       where unclassified.workspace_id = $1
         and ($3::date is null
           or (unclassified.transaction_local_date, unclassified.id) < ($3::date, $4::uuid))
       order by unclassified.transaction_local_date desc, unclassified.id desc
       limit $2`,
      [workspaceId, limit + 1, cursorDate, cursorId],
    );
    const hasNextPage = result.rows.length > limit;
    const rows = hasNextPage ? result.rows.slice(0, limit) : result.rows;
    const items = rows.map(queueItem);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        hasNextPage && last !== undefined
          ? { id: last.id, transactionLocalDate: last.transactionLocalDate }
          : null,
    };
  }
}
