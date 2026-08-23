# ADR 0010: Provider identity and credit-card bill semantics

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§8.2, 8.8–8.10, 9.4, 9.6, 11.5–11.7
- **Follow-up:** PF-006 expands matching and reconciliation rules

## Context

Provider transaction IDs may be revised or replaced, credit-card amount signs do not uniquely define
economic meaning, and one card-bill payment can appear as bill metadata, a card transaction, and a
bank-account debit. Treating these representations as independent spending or silently merging them
would corrupt totals and user-owned annotations.

## Decision

Preserve provider evidence separately from logical continuity and economic interpretation.

- A provider ID identifies one provider record; deletion plus a new ID preserves both records.
- Possible replacement is represented by a scored `transaction_identity_link`. Only an unambiguous
  high-confidence match or explicit user confirmation transfers eligible user state to an empty
  successor, with audit history.
- A dedupe fingerprint is a review aid, never a globally unique financial identity or automatic merge
  instruction.
- Store exact signed provider and account-currency amounts, provider type, timestamps, and operation
  fields. Derive `direction` and `financial_role` independently under versioned policy.
- Never classify a negative card amount as a bill payment from sign alone.
- Normalize bills, bill payments, and finance charges as child entities and reconcile them with card
  and bank transactions.
- Multiple representations of one bill payment are linked evidence for one economic event: spending
  excludes the payment, while cash flow includes only the confirmed bank-account outflow.
- Finance charges count once when reconciled to a transaction; unmatched metadata remains visible
  rather than creating synthetic spending.
- Provider synchronization updates provider-owned facts but never overwrites user-owned transaction
  state.

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

## Consequences

- Totals remain explainable across provider replacement and bill reconciliation.
- User notes, overrides, and review state survive only controlled continuity decisions.
- Additional identity, child-entity, candidate, and reconciliation tables and review UI are required.
- Some events remain explicitly unresolved until stronger evidence or owner confirmation exists.
- Analytics must use effective, reconciled views rather than raw amount signs or provider rows alone.

## Deferred detail

PF-006 will document the replacement scoring evidence, signed-card policy matrix, bill child-entity
constraints, and economic-event reconciliation cases in operational detail.
