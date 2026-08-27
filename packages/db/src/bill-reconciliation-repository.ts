import type { Pool, PoolClient } from 'pg';

export interface CardBillReconciliationSummary {
  billId: string;
  billStatus: string;
  cardId: string;
  closeDate: string | null;
  confirmedBankPaymentCount: number;
  confirmedBankPaymentTotal: string;
  currency: string;
  differenceAmount: string | null;
  dueDate: string | null;
  financeChargeTotal: string;
  lastSuccessfulSyncAt: Date | null;
  linkedTransactionTotal: string;
  normalizedPaymentTotal: string;
  pendingPurchaseTotal: string;
  policyVersion: number;
  postedNetSpendingTotal: string;
  providerBillTotal: string | null;
  reconciliationStatus: 'NEEDS_REVIEW' | 'RECONCILED' | 'TOLERANCE_REQUIRED' | 'UNKNOWN';
  toleranceAmount: string | null;
  unresolvedItemCount: number;
  unconvertedTransactionCount: number;
}

export interface BillPaymentReconciliationCandidate {
  amount: string;
  confidence: string | null;
  currency: string;
  description: string;
  id: string;
  matchStatus: 'AUTO_MATCHED' | 'CANDIDATE' | 'REJECTED' | 'UNMATCHED' | 'USER_CONFIRMED';
  transactionDate: string;
  transactionId: string;
}

interface SummaryRow {
  bill_id: string;
  bill_status: string;
  card_id: string;
  close_date: string | null;
  confirmed_bank_payment_count: number;
  confirmed_bank_payment_total: string;
  currency: string;
  difference_amount: string | null;
  due_date: string | null;
  finance_charge_total: string;
  last_successful_sync_at: Date | null;
  linked_transaction_total: string;
  normalized_payment_total: string;
  pending_purchase_total: string;
  policy_version: number;
  posted_net_spending_total: string;
  provider_bill_total: string | null;
  reconciliation_status: CardBillReconciliationSummary['reconciliationStatus'];
  tolerance_amount: string | null;
  unresolved_item_count: number;
  unconverted_transaction_count: number;
}

interface CandidateRow {
  amount: string;
  confidence: string | null;
  currency: string;
  description: string;
  id: string;
  match_status: BillPaymentReconciliationCandidate['matchStatus'];
  transaction_date: string;
  transaction_id: string;
}

function requireText(name: string, value: string, maximum: number): string {
  if (value.trim() !== value || value.length === 0 || value.length > maximum) {
    throw new TypeError(`${name} must contain 1 to ${maximum} trimmed characters.`);
  }
  return value;
}

function summary(row: SummaryRow): CardBillReconciliationSummary {
  return {
    billId: row.bill_id,
    billStatus: row.bill_status,
    cardId: row.card_id,
    closeDate: row.close_date,
    confirmedBankPaymentCount: row.confirmed_bank_payment_count,
    confirmedBankPaymentTotal: row.confirmed_bank_payment_total,
    currency: row.currency,
    differenceAmount: row.difference_amount,
    dueDate: row.due_date,
    financeChargeTotal: row.finance_charge_total,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    linkedTransactionTotal: row.linked_transaction_total,
    normalizedPaymentTotal: row.normalized_payment_total,
    pendingPurchaseTotal: row.pending_purchase_total,
    policyVersion: row.policy_version,
    postedNetSpendingTotal: row.posted_net_spending_total,
    providerBillTotal: row.provider_bill_total,
    reconciliationStatus: row.reconciliation_status,
    toleranceAmount: row.tolerance_amount,
    unresolvedItemCount: row.unresolved_item_count,
    unconvertedTransactionCount: row.unconverted_transaction_count,
  };
}

function candidate(row: CandidateRow): BillPaymentReconciliationCandidate {
  return {
    amount: row.amount,
    confidence: row.confidence,
    currency: row.currency,
    description: row.description,
    id: row.id,
    matchStatus: row.match_status,
    transactionDate: row.transaction_date,
    transactionId: row.transaction_id,
  };
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('rollback');
  } catch {
    // Preserve the original database error.
  }
}

export class BillReconciliationNotFoundError extends Error {
  public constructor() {
    super('The requested bill reconciliation evidence was not found.');
    this.name = 'BillReconciliationNotFoundError';
  }
}

export class BillReconciliationConflictError extends Error {
  public constructor(message = 'The reconciliation candidate is no longer actionable.') {
    super(message);
    this.name = 'BillReconciliationConflictError';
  }
}

export class BillReconciliationRepository {
  public constructor(private readonly pool: Pool) {}

  public async getSummary(
    workspaceId: string,
    billId: string,
  ): Promise<CardBillReconciliationSummary | null> {
    const result = await this.pool.query<SummaryRow>(
      `select reconciliation.credit_card_bill_id as bill_id,
         reconciliation.financial_account_id as card_id,
         reconciliation.bill_status, reconciliation.due_date::text,
         reconciliation.close_date::text, reconciliation.currency,
         reconciliation.bill_total::numeric(20, 6)::text as provider_bill_total,
         reconciliation.linked_transaction_total::numeric(20, 6)::text,
         reconciliation.normalized_payment_total::numeric(20, 6)::text,
         reconciliation.normalized_finance_charge_total::numeric(20, 6)::text
           as finance_charge_total,
         reconciliation.confirmed_bank_payment_total::numeric(20, 6)::text,
         reconciliation.confirmed_bank_payment_count::integer,
         reconciliation.unconverted_transaction_count::integer,
         reconciliation.unresolved_item_count::integer,
         reconciliation.tolerance_amount::numeric(20, 6)::text,
         reconciliation.difference_amount::numeric(20, 6)::text,
         reconciliation.reconciliation_status,
         workspace.analytics_policy_version as policy_version,
         account.last_successful_sync_at,
         coalesce(sum(spend.spend_effect_amount) filter (
           where spend.status = 'POSTED'), 0)::numeric(20, 6)::text as posted_net_spending_total,
         coalesce(sum(greatest(spend.spend_effect_amount, 0)) filter (
           where spend.status = 'PENDING'), 0)::numeric(20, 6)::text as pending_purchase_total
       from v_credit_card_bill_reconciliation reconciliation
       join financial_account account
         on account.workspace_id = reconciliation.workspace_id
        and account.id = reconciliation.financial_account_id
       join workspace on workspace.id = reconciliation.workspace_id
       left join v_transaction_spend_effect spend
         on spend.workspace_id = reconciliation.workspace_id
        and spend.credit_card_bill_id = reconciliation.credit_card_bill_id
        and spend.deleted_at is null and spend.status <> 'DELETED'
        and spend.duplicate_review_status <> 'CONFIRMED_DUPLICATE'
       where reconciliation.workspace_id = $1 and reconciliation.credit_card_bill_id = $2
       group by reconciliation.credit_card_bill_id, reconciliation.financial_account_id,
         reconciliation.bill_status, reconciliation.due_date, reconciliation.close_date,
         reconciliation.currency, reconciliation.bill_total,
         reconciliation.linked_transaction_total, reconciliation.normalized_payment_total,
         reconciliation.normalized_finance_charge_total,
         reconciliation.confirmed_bank_payment_total,
         reconciliation.confirmed_bank_payment_count,
         reconciliation.unconverted_transaction_count, reconciliation.unresolved_item_count,
         reconciliation.tolerance_amount, reconciliation.difference_amount,
         reconciliation.reconciliation_status, workspace.analytics_policy_version,
         account.last_successful_sync_at`,
      [workspaceId, billId],
    );
    const row = result.rows[0];
    return row === undefined ? null : summary(row);
  }

  public async generateCandidates(
    workspaceId: string,
    paymentId: string,
  ): Promise<BillPaymentReconciliationCandidate[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const payment = await client.query(
        `select 1 from credit_card_bill_payment where workspace_id = $1 and id = $2 for update`,
        [workspaceId, paymentId],
      );
      if (payment.rowCount === 0) throw new BillReconciliationNotFoundError();
      await client.query(
        `insert into bill_payment_reconciliation (
           workspace_id, credit_card_bill_payment_id, financial_transaction_id,
           match_status, match_method, confidence
         )
         select $1, payment.id, transaction.id, 'CANDIDATE', 'AMOUNT_DATE_ROLE_V1',
           case when abs(abs(transaction.analytics_amount_signed) - payment.amount) = 0
             and transaction.transaction_local_date = payment.payment_date
             then 1.0000 else 0.9500 end
         from credit_card_bill_payment payment
         join reconciliation_currency_tolerance tolerance on tolerance.currency = payment.currency
         join v_financial_transaction_effective transaction on transaction.workspace_id = payment.workspace_id
           and transaction.status = 'POSTED' and transaction.deleted_at is null
           and transaction.duplicate_review_status <> 'CONFIRMED_DUPLICATE'
           and transaction.system_direction = 'OUTFLOW'
           and transaction.effective_financial_role = 'CARD_BILL_PAYMENT'
           and transaction.analytics_currency = payment.currency
           and transaction.analytics_amount_signed is not null
           and abs(abs(transaction.analytics_amount_signed) - payment.amount) <= tolerance.tolerance_amount
           and abs(transaction.transaction_local_date - payment.payment_date) <= 2
           and (transaction.credit_card_bill_id is null
             or transaction.credit_card_bill_id = payment.credit_card_bill_id)
         join financial_account account on account.workspace_id = transaction.workspace_id
           and account.id = transaction.financial_account_id
           and account.account_type in ('CHECKING', 'SAVINGS') and account.deleted_at is null
         where payment.workspace_id = $1 and payment.id = $2
           and not exists (
             select 1 from bill_payment_reconciliation active
             where active.workspace_id = $1
               and active.match_status in ('AUTO_MATCHED', 'USER_CONFIRMED')
               and (active.credit_card_bill_payment_id = payment.id
                 or active.financial_transaction_id = transaction.id)
           )
         on conflict (workspace_id, credit_card_bill_payment_id, financial_transaction_id)
         do nothing`,
        [workspaceId, paymentId],
      );
      const candidates = await this.listCandidatesWithClient(client, workspaceId, paymentId);
      await client.query('commit');
      return candidates;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  public async confirmCandidate(
    workspaceId: string,
    paymentId: string,
    candidateId: string,
    actorId: string,
  ): Promise<BillPaymentReconciliationCandidate> {
    return this.resolveCandidate(workspaceId, paymentId, candidateId, actorId, 'USER_CONFIRMED');
  }

  public async rejectCandidate(
    workspaceId: string,
    paymentId: string,
    candidateId: string,
    actorId: string,
  ): Promise<BillPaymentReconciliationCandidate> {
    return this.resolveCandidate(workspaceId, paymentId, candidateId, actorId, 'REJECTED');
  }

  private async listCandidatesWithClient(
    client: PoolClient,
    workspaceId: string,
    paymentId: string,
  ): Promise<BillPaymentReconciliationCandidate[]> {
    const result = await client.query<CandidateRow>(
      `select reconciliation.id, reconciliation.financial_transaction_id as transaction_id,
         reconciliation.match_status, reconciliation.confidence::text,
         transaction.transaction_local_date::text as transaction_date,
         abs(transaction.analytics_amount_signed)::numeric(20, 6)::text as amount,
         transaction.analytics_currency as currency, transaction.description_original as description
       from bill_payment_reconciliation reconciliation
       join v_financial_transaction_effective transaction
         on transaction.workspace_id = reconciliation.workspace_id
        and transaction.id = reconciliation.financial_transaction_id
       where reconciliation.workspace_id = $1
         and reconciliation.credit_card_bill_payment_id = $2
       order by case reconciliation.match_status
         when 'USER_CONFIRMED' then 0 when 'AUTO_MATCHED' then 1 when 'CANDIDATE' then 2 else 3 end,
         reconciliation.confidence desc nulls last, transaction.transaction_local_date,
         reconciliation.id
       limit 20`,
      [workspaceId, paymentId],
    );
    return result.rows.map(candidate);
  }

  private async resolveCandidate(
    workspaceId: string,
    paymentId: string,
    candidateId: string,
    actorIdInput: string,
    targetStatus: 'REJECTED' | 'USER_CONFIRMED',
  ): Promise<BillPaymentReconciliationCandidate> {
    const actorId = requireText('actorId', actorIdInput, 200);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const existing = await client.query<{ match_status: string }>(
        `select match_status from bill_payment_reconciliation
         where workspace_id = $1 and id = $2 and credit_card_bill_payment_id = $3 for update`,
        [workspaceId, candidateId, paymentId],
      );
      const row = existing.rows[0];
      if (row === undefined) throw new BillReconciliationNotFoundError();
      if (row.match_status !== 'CANDIDATE' && row.match_status !== targetStatus) {
        throw new BillReconciliationConflictError();
      }
      if (row.match_status === 'CANDIDATE') {
        try {
          await client.query(
            `update bill_payment_reconciliation set match_status = $4,
               match_method = case when $4 = 'USER_CONFIRMED' then 'USER' else match_method end,
               matched_at = case when $4 = 'USER_CONFIRMED' then now() else null end,
               confirmed_by = case when $4 = 'USER_CONFIRMED' then $5 else null end,
               updated_at = now()
             where workspace_id = $1 and id = $2 and credit_card_bill_payment_id = $3`,
            [workspaceId, candidateId, paymentId, targetStatus, actorId],
          );
        } catch (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new BillReconciliationConflictError(
              'Another active reconciliation already exists.',
            );
          }
          throw error;
        }
        await client.query(
          `insert into audit_event (
             workspace_id, actor_type, actor_id, event_type, target_type, target_id, details
           ) values ($1, 'USER', $2, $3, 'BILL_PAYMENT_RECONCILIATION', $4,
             jsonb_build_object('paymentId', $5::text))`,
          [
            workspaceId,
            actorId,
            targetStatus === 'USER_CONFIRMED'
              ? 'BILL_PAYMENT_RECONCILIATION_CONFIRMED'
              : 'BILL_PAYMENT_RECONCILIATION_REJECTED',
            candidateId,
            paymentId,
          ],
        );
      }
      const candidates = await this.listCandidatesWithClient(client, workspaceId, paymentId);
      const resolved = candidates.find((item) => item.id === candidateId);
      if (resolved === undefined) throw new BillReconciliationNotFoundError();
      await client.query('commit');
      return resolved;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
