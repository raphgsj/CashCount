# API application

`@cashcount/api` is the Fastify Finance API service. It exposes request-identified process liveness
at `GET /health/live` and database-backed readiness at `GET /health/ready`; readiness performs only
a lightweight PostgreSQL query and never calls Pluggy. Responses disable caching, bounded failures
use problem objects without stack traces, and unknown routes fail closed.

Three independent strict bearer guards bind credentials to server-owned principals:

- `WEB_TO_API_TOKEN` → `service_web`, owner role, configured `API_WORKSPACE_ID`;
- `MCP_TO_API_READONLY_TOKEN` → `service_mcp_readonly`, read-only role, the same configured workspace;
- `PLUGGY_WEBHOOK_SECRET` → `service_webhook`, with workspace determined only from stored provider
  identity.

The API rejects detectable credential reuse and route-dependency workspace mismatch. A caller
cannot provide a role or workspace. Generated OpenAPI is available at `GET /documentation/json`
only when `NODE_ENV=development`; it is absent in test and production.

PF-061 exposes these bounded web-owner reads through the fixed server-side workspace:

- `GET /v1/accounts` and `GET /v1/accounts/:id`;
- `GET /v1/cards`, `GET /v1/cards/:id`, and `GET /v1/cards/:id/bills`;
- `GET /v1/card-bills/:id`, `/payments`, and `/finance-charges`.

Amounts are exact decimal-string money objects. Responses include masked numbers and normalized
history/freshness or bill evidence, but never provider/external identifiers, raw payloads, or full
account/card numbers. Lists are capped at 100, all repository methods require `workspaceId`, and
MCP/webhook credentials cannot substitute for the web-owner credential. Installment routes remain
reserved for PF-067.

PF-062 exposes `GET /v1/transactions`, `GET /v1/transactions/:id`, and
`PATCH /v1/transactions/:id` to the same web-owner boundary. Lists require a bounded `from`/`to`
range of at most 366 days, accept allow-listed filters, and use an opaque cursor bound to those
filters with stable `(transaction_local_date desc, id desc)` ordering. Responses include exact
signed original and optional account-currency money, effective values with source/override state,
owner notes/review/tags, bill and provider-replacement context, freshness, and structured
history/currency warnings. They omit all provider/external identities and raw evidence.
Long CPF/account/card-like digit sequences in provider descriptions are masked to last four before
serialization.

PATCH accepts only user-owned fields with explicit `SET`, `CLEAR`, or `INHERIT` semantics.
`expectedVersion` protects state and tag replacement in one transaction; stale writes return `409`.
Category, merchant, and tag references must be visible in the fixed workspace. Provider amounts,
dates, descriptions, status, and identifiers are not patchable. Classification, duplicate-review,
and transfer-link commands remain outside PF-062.

PF-063 exposes bounded category, canonical-merchant, and classification-rule management to the same
web-owner boundary:

- `GET /v1/categories`, `POST /v1/categories`, and `PATCH /v1/categories/:id`;
- `GET /v1/merchants`, `GET|PATCH /v1/merchants/:id`, and `POST /v1/merchants/merge`;
- `GET|POST /v1/classification-rules`, `PATCH|DELETE /v1/classification-rules/:id`, and
  `POST /v1/classification-rules/:id/test`.

Global categories are readable but not mutable. Workspace category parentage and rule action
references are validated before writes. Merchant responses omit identity hashes and provider
identifiers; merges lock both same-workspace merchants, preserve confirmed aliases, rewire known
merchant references including strict rule documents, and record an audit event atomically. Rule
creation always uses owner source, system suggestions remain inactive until an explicit audited
activation, and DELETE deactivates the row instead of deleting its evidence. Rule tests scan a
bounded date range with the pure evaluator, mask sensitive digit sequences, and do not persist
classification decisions or hit counts.

PF-064 exposes `GET /v1/analytics/spending-summary` to independently authenticated web-owner and
MCP-read-only callers for the fixed server-side workspace. The route requires a bounded date range,
accepts allow-listed account/category/merchant, granularity, and pending-status filters, and reads
only the canonical effective spend and deposit-account cash-flow views. It returns exact decimal
strings separately by currency and posted/pending status, bounded category/merchant breakdowns and
time series, accounting-policy version, freshness, and applicable incomplete-history,
unconverted-currency, unreconciled-bill, stale-data, connection-attention, and truncation warnings.
No internal or provider identity is exposed.

PF-065 exposes `GET /v1/analytics/compare-periods` through the same independent read guards. It
compares canonical net spending against a previous equal period, shifted month, shifted year, or
explicit custom range. Optional same-elapsed-day mode trims both ranges to their shared day count.
Results remain separate by currency/status and include exact current/comparison totals, absolute
differences, percentage differences (null when the comparison total is zero), up to 100 largest
category changes, freshness, policy version, and applicable warnings. Card-bill reconciliation
commands are implemented by PF-066.

PF-066 exposes `GET /v1/card-bills/:id/reconciliation` to independent web-owner and MCP-read-only
credentials. The exact summary labels provider bill, linked posted/pending activity, normalized
payments/charges, confirmed bank payments, difference/tolerance, unresolved evidence, freshness,
policy version, and reconciliation warnings without declaring local or provider values universally
authoritative. Web-owner-only POST commands generate up to 20 conservative candidates and confirm
or reject a selected candidate. Candidate generation requires matching currency/configured
tolerance, ±2 days, a posted live deposit-account outflow, and effective bill-payment role.
Resolution is workspace-scoped, transactional, idempotent in its resolved state, audited, and still
subject to PostgreSQL active-match uniqueness. MCP cannot invoke commands. Installment commitments
are implemented by PF-067.

PF-067 exposes `GET /v1/analytics/installment-commitments` to web-owner and MCP-read-only callers and
`GET /v1/cards/:id/installments` to web owners. Analytics include only confirmed series with
remaining installments, never candidate/review rows, and omit internal IDs. Exact per-series and
monthly currency-separated estimates use the canonical commitment view and label the
monthly-from-purchase-date assumption. Missing purchase dates or installment amounts remain
unallocated with warnings instead of being fabricated. The card route surfaces candidate,
needs-review, confirmed, and completed states for owner review without adding them to committed
totals. Recurring detection remains reserved for PF-068.

PF-040's `POST /webhooks/pluggy` route retains its isolated webhook guard, accepts only
`application/json`, and enforces a 256 KiB limit before persistence. PF-045's bounded web-owner sync
run, dead-letter, retry, and manual-reconciliation routes now run through Fastify without expanding
their authorization surface. The MCP guard is implemented for later approved read-only routes but
has no general or administrative route access.

The route validates the ten first-wave Item/transaction events documented by Pluggy, rejects all
payment event types, maps workspace scope only through stored Item/account identities, encrypts the
validated original payload with the active key, and transactionally inserts one `PROCESS_WEBHOOK`
job containing only the internal inbox ID. Unknown or ambiguous identities remain explicitly
`UNMAPPED` with a nullable-workspace repair job. Duplicate deliveries return the same `202` without
creating another row or job.

No provider client is invoked by the API webhook route. Provider retrieval and event handling stay
in the worker; the ingestion response follows only the bounded database transaction.

Payload field requirements are based on the official
[Pluggy webhook guide](https://docs.pluggy.ai/docs/webhooks). Additive fields are retained in the
encrypted envelope but never treated as authoritative workspace or financial state.
