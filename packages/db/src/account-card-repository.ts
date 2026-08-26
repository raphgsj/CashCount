import type { Pool } from 'pg';

export type AccountType = 'CHECKING' | 'CREDIT_CARD' | 'INVESTMENT' | 'OTHER' | 'SAVINGS';
export type HistoryCoverageStatus =
  'PARTIAL' | 'PROVIDER_MAXIMUM_RETRIEVED' | 'UNKNOWN' | 'USER_EXTENDED_HISTORY';

export interface AccountCardRecord {
  accountSubtype: null | string;
  accountType: AccountType;
  availableBalance: null | string;
  availableCreditLimit: null | string;
  closingDay: null | number;
  creditLimit: null | string;
  currency: string;
  currentBalance: null | string;
  dueDay: null | number;
  historyCoverageStatus: HistoryCoverageStatus;
  id: string;
  institutionName: string;
  isActive: boolean;
  lastSuccessfulSyncAt: Date | null;
  maskedNumber: null | string;
  name: string;
  providerHistoryEarliestDate: null | string;
  providerHistoryLatestDate: null | string;
}

export interface CardBillRecord {
  allowsInstallments: boolean | null;
  cardId: string;
  closeDate: null | string;
  currency: string;
  dueDate: null | string;
  id: string;
  minimumPayment: null | string;
  status: string;
  totalAmount: null | string;
}

export interface CardBillPaymentRecord {
  amount: string;
  currency: string;
  id: string;
  isMatchedToCardTransaction: boolean;
  paymentDate: string;
  paymentMode: null | string;
  valueType: string;
}

export interface CardBillFinanceChargeRecord {
  additionalInfo: null | string;
  amount: string;
  chargeType: string;
  currency: string;
  id: string;
  isMatchedToTransaction: boolean;
}

interface AccountRow {
  account_subtype: null | string;
  account_type: AccountType;
  available_balance: null | string;
  available_credit_limit: null | string;
  closing_day: null | number;
  credit_limit: null | string;
  currency: string;
  current_balance: null | string;
  due_day: null | number;
  history_coverage_status: HistoryCoverageStatus;
  id: string;
  institution_name: string;
  is_active: boolean;
  last_successful_sync_at: Date | null;
  masked_number: null | string;
  name: string;
  provider_history_earliest_date: null | string;
  provider_history_latest_date: null | string;
}

interface BillRow {
  allows_installments: boolean | null;
  card_id: string;
  close_date: null | string;
  currency: string;
  due_date: null | string;
  id: string;
  minimum_payment: null | string;
  status: string;
  total_amount: null | string;
}

interface PaymentRow {
  amount: string;
  currency: string;
  id: string;
  is_matched_to_card_transaction: boolean;
  payment_date: string;
  payment_mode: null | string;
  value_type: string;
}

interface FinanceChargeRow {
  additional_info: null | string;
  amount: string;
  charge_type: string;
  currency: string;
  id: string;
  is_matched_to_transaction: boolean;
}

const accountColumns = `id, account_type, account_subtype, name, institution_name, currency,
  masked_number, current_balance::text, available_balance::text, credit_limit::text,
  available_credit_limit::text, closing_day, due_day, is_active, last_successful_sync_at,
  provider_history_earliest_date::text, provider_history_latest_date::text,
  history_coverage_status`;

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('Account/card list limit must be an integer from 1 to 100.');
  }
}

function accountRecord(row: AccountRow): AccountCardRecord {
  return {
    accountSubtype: row.account_subtype,
    accountType: row.account_type,
    availableBalance: row.available_balance,
    availableCreditLimit: row.available_credit_limit,
    closingDay: row.closing_day,
    creditLimit: row.credit_limit,
    currency: row.currency,
    currentBalance: row.current_balance,
    dueDay: row.due_day,
    historyCoverageStatus: row.history_coverage_status,
    id: row.id,
    institutionName: row.institution_name,
    isActive: row.is_active,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    maskedNumber: row.masked_number,
    name: row.name,
    providerHistoryEarliestDate: row.provider_history_earliest_date,
    providerHistoryLatestDate: row.provider_history_latest_date,
  };
}

function billRecord(row: BillRow): CardBillRecord {
  return {
    allowsInstallments: row.allows_installments,
    cardId: row.card_id,
    closeDate: row.close_date,
    currency: row.currency,
    dueDate: row.due_date,
    id: row.id,
    minimumPayment: row.minimum_payment,
    status: row.status,
    totalAmount: row.total_amount,
  };
}

export class AccountCardRepository {
  public constructor(private readonly pool: Pool) {}

  public async listAccounts(workspaceId: string, limit = 100): Promise<AccountCardRecord[]> {
    requireLimit(limit);
    const result = await this.pool.query<AccountRow>(
      `select ${accountColumns} from financial_account
       where workspace_id = $1 and deleted_at is null
       order by account_type, institution_name, name, id limit $2`,
      [workspaceId, limit],
    );
    return result.rows.map(accountRecord);
  }

  public async getAccount(
    workspaceId: string,
    accountId: string,
  ): Promise<AccountCardRecord | null> {
    const result = await this.pool.query<AccountRow>(
      `select ${accountColumns} from financial_account
       where workspace_id = $1 and id = $2 and deleted_at is null limit 1`,
      [workspaceId, accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : accountRecord(row);
  }

  public async listCards(workspaceId: string, limit = 100): Promise<AccountCardRecord[]> {
    requireLimit(limit);
    const result = await this.pool.query<AccountRow>(
      `select ${accountColumns} from financial_account
       where workspace_id = $1 and account_type = 'CREDIT_CARD' and deleted_at is null
       order by institution_name, name, id limit $2`,
      [workspaceId, limit],
    );
    return result.rows.map(accountRecord);
  }

  public async getCard(workspaceId: string, cardId: string): Promise<AccountCardRecord | null> {
    const result = await this.pool.query<AccountRow>(
      `select ${accountColumns} from financial_account
       where workspace_id = $1 and id = $2 and account_type = 'CREDIT_CARD'
         and deleted_at is null limit 1`,
      [workspaceId, cardId],
    );
    const row = result.rows[0];
    return row === undefined ? null : accountRecord(row);
  }

  public async listCardBills(
    workspaceId: string,
    cardId: string,
    limit = 100,
  ): Promise<CardBillRecord[] | null> {
    requireLimit(limit);
    const card = await this.getCard(workspaceId, cardId);
    if (card === null) return null;
    const result = await this.pool.query<BillRow>(
      `select b.id, b.financial_account_id as card_id, b.status, b.due_date::text,
              b.close_date::text, b.total_amount::text, b.minimum_payment::text,
              b.currency, b.allows_installments
       from credit_card_bill b
       where b.workspace_id = $1 and b.financial_account_id = $2
       order by b.due_date desc nulls last, b.id desc limit $3`,
      [workspaceId, cardId, limit],
    );
    return result.rows.map(billRecord);
  }

  public async getCardBill(workspaceId: string, billId: string): Promise<CardBillRecord | null> {
    const result = await this.pool.query<BillRow>(
      `select b.id, b.financial_account_id as card_id, b.status, b.due_date::text,
              b.close_date::text, b.total_amount::text, b.minimum_payment::text,
              b.currency, b.allows_installments
       from credit_card_bill b
       join financial_account a
         on a.workspace_id = b.workspace_id and a.id = b.financial_account_id
        and a.account_type = 'CREDIT_CARD' and a.deleted_at is null
       where b.workspace_id = $1 and b.id = $2 limit 1`,
      [workspaceId, billId],
    );
    const row = result.rows[0];
    return row === undefined ? null : billRecord(row);
  }

  public async listBillPayments(
    workspaceId: string,
    billId: string,
    limit = 100,
  ): Promise<CardBillPaymentRecord[] | null> {
    requireLimit(limit);
    if ((await this.getCardBill(workspaceId, billId)) === null) return null;
    const result = await this.pool.query<PaymentRow>(
      `select id, value_type, payment_date::text, payment_mode, amount::text, currency,
              (matched_card_transaction_id is not null) as is_matched_to_card_transaction
       from credit_card_bill_payment
       where workspace_id = $1 and credit_card_bill_id = $2
       order by payment_date desc, id desc limit $3`,
      [workspaceId, billId, limit],
    );
    return result.rows.map((row) => ({
      amount: row.amount,
      currency: row.currency,
      id: row.id,
      isMatchedToCardTransaction: row.is_matched_to_card_transaction,
      paymentDate: row.payment_date,
      paymentMode: row.payment_mode,
      valueType: row.value_type,
    }));
  }

  public async listBillFinanceCharges(
    workspaceId: string,
    billId: string,
    limit = 100,
  ): Promise<CardBillFinanceChargeRecord[] | null> {
    requireLimit(limit);
    if ((await this.getCardBill(workspaceId, billId)) === null) return null;
    const result = await this.pool.query<FinanceChargeRow>(
      `select id, charge_type, amount::text, currency, additional_info,
              (matched_transaction_id is not null) as is_matched_to_transaction
       from credit_card_bill_finance_charge
       where workspace_id = $1 and credit_card_bill_id = $2
       order by charge_type, id limit $3`,
      [workspaceId, billId, limit],
    );
    return result.rows.map((row) => ({
      additionalInfo: row.additional_info,
      amount: row.amount,
      chargeType: row.charge_type,
      currency: row.currency,
      id: row.id,
      isMatchedToTransaction: row.is_matched_to_transaction,
    }));
  }
}
