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

Transaction role, spending, cash-flow, and provider mapping behavior remain later ticket work.
