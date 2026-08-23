# Domain package

`@cashcount/domain` owns provider-neutral financial policy and value types. PF-020 introduces the
first executable domain boundary:

- `Money` uses a pinned Decimal implementation and rejects implicit cross-currency arithmetic;
- every accepted amount is a fixed-point PostgreSQL `numeric(20,6)`-compatible string and JSON
  serialization never emits a JavaScript number;
- provider-signed and optional account-currency amounts remain independent evidence;
- bank dates and month-only bill forecasts are validated without local-time coercion; and
- transaction-local dates are derived from explicit-offset instants with any valid workspace IANA
  timezone, including daylight-saving transitions.

PF-021 adds the provider-neutral transaction policy. It applies an account-aware sign/evidence
matrix, never sign alone, and calculates purchase-based spending separately from deposit-account
cash flow. Card payments count only on the bank side, transfers are neutral, bill children remain
evidence-only, matched finance charges count through the transaction once, unresolved card credits
remain zero pending review, and incompatible currencies produce structured warnings without a
fabricated conversion.

Provider DTO validation and provider-specific mapping remain later ticket work.
