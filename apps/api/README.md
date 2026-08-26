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
MCP/webhook credentials cannot substitute for the web-owner credential. Bill reconciliation and
installment routes remain reserved for PF-066 and PF-067.

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
