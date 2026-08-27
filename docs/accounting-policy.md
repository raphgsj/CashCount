# CashCount accounting policy

CashCount analytics use the version stored in `workspace.analytics_policy_version`. Version `1`
implements the following deterministic rules. A material formula change requires a new version and
regression fixtures; historical responses always report the version used.

## Spending

Spending answers what the owner bought or consumed. It uses effective user/system classification
from `v_transaction_spend_effect`:

- purchases, fees, and taxes increase gross and net spending;
- refunds and credits increase the refund total and reduce net spending;
- transfers, card-bill payments, excluded rows, deleted rows, and confirmed duplicates contribute
  zero;
- finance-charge metadata never creates synthetic spending; a matched transaction is counted once.

## Deposit-account cash flow

Cash flow answers what entered or left checking and savings accounts. It uses
`v_transaction_cashflow_effect`:

- deposit-account inflows are positive and outflows are negative;
- internal transfers contribute zero to net external cash flow;
- a confirmed bank-side card payment contributes one outflow, while bill-child and card-side payment
  evidence contribute zero;
- credit-card, investment, and other non-deposit accounts do not directly contribute.

Spending and cash flow remain separate metrics and must never be substituted for one another.

## Currency, status, and evidence

- Monetary arithmetic is PostgreSQL `numeric`; APIs serialize exact decimal strings.
- Account-currency amounts are used when provider supplied. Original amounts are used only when the
  original and account currencies match.
- Incompatible, unconverted rows are omitted from totals and reported with
  `UNCONVERTED_CURRENCY`.
- Currency groups are returned separately and are never silently combined.
- Posted and explicitly requested pending results remain separate status buckets.
- Remaining installment amounts and forecasts are estimates, never primary transactions.

Every analytics response includes policy version, generation time, freshness, and applicable
incomplete-history, currency, reconciliation, connection, and staleness warnings.
