# ADR 0010: Provider identity and credit-card bill semantics

- **Status:** Accepted
- **Date:** 2026-08-23
- **Tickets:** PF-003; expanded by PF-006
- **Plan references:** §§8.2, 8.8–8.10, 9.4, 9.6, 11.5–11.7, 22

## Context

Provider transaction IDs identify provider records, not necessarily immutable real-world events.
Pluggy may delete a transaction and create another ID after a material change. A repeated dedupe
fingerprint can also describe two legitimate purchases. Treating either signal as proof of identity
would erase audit evidence or move user decisions to the wrong transaction.

Credit-card evidence has a separate ambiguity. Amount sign describes movement of the card balance,
but does not uniquely establish economic meaning: a negative card amount can be a refund, credit,
adjustment, or bill payment. One bill payment may also appear as bill metadata, a card-side
transaction, and a checking-account debit. Finance charges may appear both in bill metadata and as
transactions. Counting every representation independently corrupts spending and cash-flow totals.

## Decision

Keep provider record identity, logical transaction continuity, and economic-event reconciliation as
three distinct concepts.

1. Provider synchronization preserves every provider record and its revision history. A new provider
   ID always creates a new normalized record.
2. A scored `transaction_identity_link` records possible or confirmed continuity without merging or
   deleting either record.
3. User state moves only after unambiguous high-confidence or explicit user confirmation, only into
   an empty non-conflicting successor, and with a complete audit trail.
4. Store exact signed provider and account-currency amounts. Derive direction and financial role
   independently from account-aware evidence under versioned policy.
5. Normalize provider bill payments and finance charges as child evidence; never silently synthesize
   primary financial transactions from bill metadata.
6. Reconcile bill, card, and bank representations before analytics so one economic event contributes
   at most once to the applicable spending or cash-flow view.
7. Provider synchronization updates provider-owned and deterministic system fields but never writes
   `transaction_user_state`.

## Identity layers

| Layer                     | Identifier/evidence                                     | Meaning                                                       |
| ------------------------- | ------------------------------------------------------- | ------------------------------------------------------------- |
| Provider record identity  | `(workspace_id, provider, provider_transaction_id)`     | One versioned provider record; unique when ID is non-null     |
| Logical continuity        | Confirmed `transaction_identity_link` chain             | A predecessor and successor believed to represent one event   |
| Duplicate-review evidence | `dedupe_fingerprint` and similarity features            | A review signal only; never identity or automatic merge proof |
| Bill economic-event links | Bill child, card match, and bank reconciliation records | Multiple representations that analytics must count only once  |

The partial provider-ID unique index prevents duplicate ingestion of the same current provider
record inside a workspace. It does not make an external ID global, and it does not authorize an
upsert in another workspace. Raw encrypted snapshots remain immutable evidence for every observed
version.

## Provider-ID lifecycle and replacement

### Same provider ID

- A provider update changes provider-owned facts on the existing normalized row and records a
  revision for material changes.
- A deletion sets provider status to `DELETED` and `deleted_at`; it does not remove raw evidence,
  user state, tags, classification history, or related review records.
- Reappearance of the same ID clears `deleted_at`, restores the observed status, and records a
  revision. It is not a replacement.

### Different provider ID

When a deleted record and newly observed record might represent the same logical transaction, retain
both rows and create a `transaction_identity_link` candidate with:

- the shared `workspace_id`;
- composite workspace foreign keys to predecessor and successor;
- `link_type = PROVIDER_REPLACEMENT`;
- status `AUTO_CONFIRMED`, `NEEDS_REVIEW`, `USER_CONFIRMED`, or `REJECTED`;
- a bounded numeric confidence and non-sensitive comparison features;
- detection/confirmation timestamps and a safe actor reference.

Reject self-links and cross-workspace links. A predecessor may have at most one active confirmed
successor. Candidate creation is idempotent for the same predecessor/successor/link type. Both source
records remain queryable and auditable after confirmation.

### Candidate eligibility and scoring

Evaluate a replacement candidate only when all hard eligibility conditions hold:

- the predecessor was deleted and the successor appeared in the same sync window;
- both records belong to the same workspace and financial account;
- original currencies match and signed amounts are equal or compatible under an explicitly
  documented provider correction rule;
- local transaction dates fall within the small configured replacement window;
- installment, bill period, card suffix, and MCC evidence do not conflict when present.

Score eligible candidates using amount/currency compatibility, local-date distance, normalized
description similarity, provider operation/type evidence, and compatible installment, bill, card,
and MCC features. Missing optional enrichment is neutral rather than conflicting.

The initial auto-confirm threshold is `>= 0.95`. Auto-confirm also requires a single unambiguous
predecessor/successor match with no plausible competing candidate. Thresholds, feature weights, and
date windows belong to a versioned deterministic policy and sanitized regression fixtures. A score
below the threshold, competing match, or conflicting evidence creates `NEEDS_REVIEW`; it never
silently merges records. An owner may confirm or reject the candidate explicitly.

The dedupe fingerprint remains a separate review aid. A collision between distinct provider IDs sets
duplicate review state but is not proof of replacement, even when amount, date, and description are
identical.

### Transfer of user state

Confirmation runs a dedicated transactional continuity operation, not a provider upsert. It:

1. Locks the predecessor, successor, link, user-state rows, and tag joins needed for the decision.
2. Verifies the link is confirmed and the successor still has no conflicting manual state or tags.
3. Copies notes, category/merchant/financial-role overrides (including enabled/explicit-null modes),
   exclusion override, review state, and tags to the empty successor.
4. Preserves predecessor state and both provider records.
5. Records the policy version, actor, link, and exact fields/tags copied in bounded audit/revision
   records.
6. Never copies provider status, provider facts, system classification, or duplicate-review status.
7. Is idempotent: retrying a completed transfer neither duplicates tags nor increments user-state
   versions again.

If either side has conflicting manual values, the operation makes no partial transfer and leaves the
candidate for review. Rejection transfers nothing. Undo is an explicit audited user operation; it is
never achieved by deleting provider evidence.

## Signed amount and financial-role policy

Store these independent facts on every transaction when supplied:

- `provider_amount_signed`: exact provider decimal value;
- `provider_type`: exact normalized provider `DEBIT`/`CREDIT` hint;
- `provider_operation_type` and bounded additional evidence;
- `provider_currency`;
- nullable `account_currency_amount_signed` and its account currency;
- account type, bill/card metadata, exact provider timestamp, and derived workspace-local date.

Never convert signed values to magnitudes during ingestion and never use JavaScript floating point
for money. `account_currency_amount_signed` is stored only when the provider supplies it; CashCount
does not fabricate conversion. Analytics selects a compatible amount under the currency policy and
applies absolute value only after direction/role semantics are known.

Direction and financial role are derived separately using account type, sign, provider type,
operation type, fee/other-credit metadata, bill links, reconciliation, and merchant/description
evidence. Sign alone is never sufficient.

For credit-card accounts, the initial deterministic matrix is:

| Evidence                                                | Default role         | Spending effect  | Deposit-account cash-flow effect |
| ------------------------------------------------------- | -------------------- | ---------------- | -------------------------------- |
| Positive card purchase                                  | `PURCHASE`           | Positive expense | 0                                |
| Positive card fee with compatible fee evidence          | `FEE`                | Positive expense | 0                                |
| Negative card entry matched to purchase/refund evidence | `REFUND` or `CREDIT` | Reduces expense  | 0                                |
| Negative card entry confirmed as bill payment           | `CARD_BILL_PAYMENT`  | 0                | 0 on card side                   |
| Checking-account debit confirmed as card payment        | `CARD_BILL_PAYMENT`  | 0                | Outflow                          |
| Unresolved negative card entry                          | `UNKNOWN_CREDIT`     | 0 pending review | 0                                |

A positive card amount normally increases the balance; a negative amount reduces it. Those balance
effects are provider evidence, not final economic roles. In particular, no negative card entry
becomes `CARD_BILL_PAYMENT` without supporting bill/reconciliation evidence.

## Bill child entities

### Bill payment evidence

`credit_card_bill_payment` stores each provider-reported payment child with workspace and bill
identity, provider/external payment ID, value type, consistently derived payment date, nullable
payment mode, non-negative amount magnitude, currency, optional matched card transaction, latest raw
snapshot, and timestamps.

The row uses a composite workspace foreign key to the bill and is idempotently unique on:

```text
(workspace_id, credit_card_bill_id, provider, external_payment_id)
```

`matched_card_transaction_id`, when present, is a composite same-workspace foreign key and identifies
the card-side representation. A payment child is reconciliation evidence, not an independent expense
or cash movement.

### Finance-charge evidence

`credit_card_bill_finance_charge` stores workspace/bill/provider identity, external charge ID, charge
type, non-negative amount magnitude, currency, bounded additional information, optional matched
transaction, latest raw snapshot, and timestamps. It is idempotently unique within
`(workspace_id, credit_card_bill_id, provider, external_charge_id)` and uses composite workspace
foreign keys for bill and transaction references.

A finance-charge child does not automatically create spending. A matched fee/interest transaction is
the counted fact. Metadata without a matching transaction remains an unresolved bill component.

### Bill-payment reconciliation

`bill_payment_reconciliation` links one bill-payment child to a candidate checking/savings-account
transaction in the same workspace. It stores `UNMATCHED`, `CANDIDATE`, `AUTO_MATCHED`,
`USER_CONFIRMED`, or `REJECTED` status plus method, confidence, timestamps, and safe confirming actor.

Candidate matching requires compatible currency, amount within a currency-specific tolerance, a
small date window, a deposit-account outflow, and no conflicting bill/reference evidence. The
initial BRL tolerance is `0.01`; other currencies require explicit configured tolerances rather than
implicit conversion. Enforce at most one `AUTO_MATCHED` or `USER_CONFIRMED` bank transaction per bill
payment while retaining rejected and ambiguous candidates for review.

Bill payments and finance charges upsert by their provider child identities. Repeated sync therefore
updates evidence without duplicating children or active reconciliations.

## Economic-event reconciliation

One card-bill payment can have three representations:

| Representation                     | Role after confirmation | Spending contribution | Cash-flow contribution |
| ---------------------------------- | ----------------------- | --------------------- | ---------------------- |
| Provider bill `payments[]` child   | Reconciliation evidence | 0                     | 0                      |
| Matching negative card transaction | `CARD_BILL_PAYMENT`     | 0                     | 0                      |
| Matching deposit-account debit     | `CARD_BILL_PAYMENT`     | 0                     | One actual outflow     |

The bill child anchors reconciliation, `matched_card_transaction_id` links the card-side evidence,
and the active bill-payment reconciliation links the bank-side cash movement. Together they describe
one economic event without collapsing or deleting any representation.

Unmatched bill metadata and ambiguous card credits contribute neither synthetic spending nor
synthetic cash flow. They remain visible in reconciliation/review views with structured warnings.
Refunds and credits remain separate roles unless evidence confirms a bill payment.

Finance charges follow the same count-once principle:

- a matched fee/interest financial transaction contributes once to spending;
- its bill finance-charge child contributes zero additional spending;
- an unmatched finance-charge child appears in the bill's unresolved difference and creates no
  synthetic transaction in the personal MVP.

The canonical bill reconciliation view exposes bill total, linked transaction total, normalized
payments and charges, confirmed bank-payment total, currency/tolerance difference, status, and
unresolved items. Spending and cash-flow views consume effective roles and confirmed reconciliation,
not raw sign or child-row counts.

## Verification matrix

Later implementation tickets must cover this ADR with sanitized unit, provider-contract, database,
and analytics tests. At minimum, prove:

- same-ID update, deletion, and reappearance preserve one provider record and revision history;
- different-ID replacement preserves both records and creates an idempotent continuity candidate;
- low scores, competing candidates, and conflicting evidence never auto-confirm;
- confirmed replacement transfers every eligible user field and tag exactly once, while conflict or
  rejection transfers nothing;
- dedupe-fingerprint collision alone never establishes identity;
- exact signed original/account-currency values and provider type survive round trips;
- positive card purchases/fees, refunds, confirmed payments, and unresolved negative credits follow
  the policy matrix;
- bill payment and finance-charge children upsert idempotently and reject cross-workspace links;
- bill/card/bank payment representations yield zero spending and one confirmed bank cash outflow;
- a matched finance charge counts once and unmatched metadata remains visible without synthetic
  spending;
- currency mismatch or out-of-tolerance amounts remain unresolved;
- provider synchronization never writes `transaction_user_state`.

Analytics regression tests operate on the canonical effective/reconciliation views so user overrides
and warnings are applied consistently to web, API, and MCP results.

## Alternatives considered

### Overwrite a deleted transaction with its apparent successor

This hides provider history, can move notes to the wrong purchase, and makes replacement decisions
impossible to audit or reverse.

### Treat the dedupe fingerprint as transaction identity

Legitimate same-day transactions can share amount and description, so automatic merging would lose
distinct financial events.

### Infer card semantics from amount sign

Negative card amounts may be refunds, credits, adjustments, or payments. Sign alone cannot establish
the financial role.

### Flatten bill payments and charges into synthetic transactions

This simplifies querying but risks double counting and fabricates events when provider metadata has
not been reconciled to a real transaction.

### Count bill, card, and bank representations independently

This overstates bill-payment activity in both spending and cash flow and makes reconciliation
differences impossible to explain.

## Consequences

- Totals remain explainable across provider replacement and bill reconciliation.
- User notes, overrides, review state, and tags survive only controlled continuity decisions.
- Additional identity, child-entity, candidate, reconciliation, audit, and review UI are required.
- Some events remain explicitly unresolved until stronger evidence or owner confirmation exists.
- Analytics must use effective, reconciled views rather than raw amount signs or provider rows alone.
- Replacement and reconciliation policy thresholds require versioned fixtures and careful tuning.

## Enforcement and follow-up

- PF-014, PF-018, and PF-019 implement the transaction/user-state, identity-link, bill-child, and
  reconciliation schema before the initial migration is finalized.
- PF-020 and PF-021 implement exact money/date types and the signed account-aware policy.
- PF-022 through PF-026 preserve the required provider evidence and child DTOs in sanitized fixtures.
- PF-033 through PF-037 implement idempotent import, bill normalization, history, and replacement
  continuity.
- PF-055, PF-066, and the analytics views implement and verify count-once economic-event behavior.
