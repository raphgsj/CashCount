# CashCount

CashCount is a private personal-finance intelligence platform. The target system imports the
owner's financial data through a provider adapter, preserves normalized history in PostgreSQL,
and exposes deterministic analytics to an authenticated web application and a read-only MCP
server.

**Phases 0 through 4 are complete; Phase 5 is in progress through PF-057:**

- **PF-001** established the monorepo and application/package foundations.
- **PF-002** added validated application environments and production safety constraints.
- **PF-003** recorded the baseline architecture decisions in `docs/adr/`.
- **PF-004** defined credential storage, authorization boundaries, and rotation procedures.
- **PF-005** defined workspace integrity, category visibility, and repository scoping.
- **PF-006** defined provider-ID continuity, signed card semantics, and bill reconciliation.
- **PF-010** added a health-checked local PostgreSQL 18 service through Docker Compose.
- **PF-011** added Drizzle tooling, an explicit migration runner, and migration-from-zero CI coverage.
- **PF-012** added the identity/workspace schema and an idempotent synthetic local seed.
- **PF-013** added provider/synchronization persistence with encrypted evidence envelopes,
  workspace-aware webhook idempotency, a lease-ready durable queue, and sync-run integrity.
- **PF-014** added the workspace-isolated financial core schema for accounts/history, bills and
  reconciliation evidence, categories/merchants, transactions, user state, continuity, and revisions.
- **PF-015** added rules/decisions, installment and recurring series, transaction tags, and bounded
  audit events with workspace-enforced relationships.
- **PF-016** added canonical effective-transaction, spend/cash-flow, bill reconciliation,
  history/freshness, review, monthly-summary, and installment-commitment database views plus their
  supporting indexes.
- **PF-017** completed the PostgreSQL tenant-integrity boundary with catalog-verified composite
  workspace keys/foreign keys and workspace-visible classification-rule category actions.
- **PF-018** added a workspace-required transaction user-state repository with explicit override
  modes, atomic first-write locking, optimistic concurrency, notes/review state, and canonical
  effective-view reads.
- **PF-019** finalized bill payment/finance-charge evidence with configurable currency tolerances,
  active-match uniqueness, amount/date/role validation, and count-once reconciliation views.
- **PF-020** added exact Decimal-backed money/value types, string-only monetary JSON, signed
  provider/account-currency evidence, strict bank dates and bill months, and arbitrary-IANA-timezone
  local financial-date derivation.
- **PF-021** added provider-neutral account-aware direction/role classification and separate
  count-once spending/cash-flow effects for purchases, refunds, fees, transfers, card payments,
  evidence children, exclusions, unresolved credits, and mixed currencies.
- **PF-022** added strict provider-neutral runtime contracts for connection lifecycle, accounts,
  signed transactions, nullable enrichment, credit-card metadata, bills and their payment/finance-
  charge evidence, plus cursor pages and the provider interface.
- **PF-023** added Pluggy backend API-key creation, two-hour in-memory caching with five-minute
  early refresh, a single concurrent refresh guard, one-time 401 recovery, and structurally redacted
  HTTP metadata logging.
- **PF-024** added the validated Pluggy Item/account/bill/V2-transaction client, lossless provider
  number parsing, neutral mapping for signed/card/bill evidence, safe cursor and legacy-webhook hint
  normalization, bounded timeouts, and Retry-After/exponential-jitter recovery for safe reads.
- **PF-025** added a reusable sanitized Pluggy fixture matrix and adapter contract tests for signed
  amounts, original/account currencies, nullable enrichment, lifecycle edges, bill children,
  cursor-observed history bounds, and distinct provider-ID replacement evidence.
- **PF-026** completed the explicit Pluggy Item lifecycle mapper for transitive collection, success
  and partial success, user input/action, credential and consent failures, provider errors,
  deletion, precedence conflicts, and unknown fail-closed states.
- **PF-030** added context-bound AES-256-GCM payload encryption, versioned exact canonical JSON
  hashes, active-key writes and mixed-version reads, tamper detection, guarded key retirement, and
  durable resumable-rotation progress with strict 12-byte nonce/16-byte tag constraints.
- **PF-031** added an explicit-workspace Pluggy connection discovery command that validates the
  target workspace before provider access, atomically assigns normalized Item metadata, preserves
  operator-disabled connections, and prints only sanitized institution labels and local states.
- **PF-032** added workspace-scoped account import with connection-lock revalidation, active-key
  encrypted raw snapshots, canonical-hash snapshot deduplication, exact normalized balances,
  masked-number-only storage, and idempotent account upserts.
- **PF-033** added bounded V2 cursor exhaustion, encrypted transaction evidence, exact dual-currency
  and workspace-local date persistence, scoped bill linking, idempotent provider-ID lifecycle and
  revision handling, conservative duplicate review, coverage updates, and durable sync counters
  without any provider write path to user state.
- **PF-034** added workspace-scoped credit-card bill import with encrypted, hash-deduplicated bill,
  payment, and finance-charge evidence; nullable unsupported fields; idempotent child upserts; and
  scoped transaction back-linking without synthesizing financial transactions.
- **PF-035** added an explicit workspace/connection full-import command and repeated sanitized
  account→transaction→bill regression coverage proving normalized-row, raw-snapshot, and bill-child
  idempotence while preserving user-owned transaction state.
- **PF-036** added conservative per-account provider-history assessment, stable owner-extended
  coverage preservation, and a workspace-scoped range query that emits structured
  `INCOMPLETE_HISTORY` warnings whenever a request predates the actual earliest known date; its
  database gate also hardened concurrent first user-state writes to return typed conflicts.
- **PF-037** added versioned deterministic provider-replacement scoring, same-sync hard eligibility,
  ambiguity-aware review links, explicit confirmation/rejection, and idempotent conflict-safe
  transfer of every user-state field and tag with complete revision/audit evidence.
- **PF-040** added the executable Pluggy webhook route with an isolated constant-time bearer guard,
  a streaming 256 KiB cap, all ten documented first-wave schemas, encrypted transactional
  mapped/unmapped inbox persistence, one internal-ID-only job, duplicate `202` handling, and no
  provider call on the response path.
- **PF-041** added the capability-gated PostgreSQL queue repository with workspace-aware active
  dedupe, UUID-only internal payloads, atomic `SKIP LOCKED` claims, lease heartbeats, ownership- and
  expiry-checked completion/failure, bounded retry/dead-letter transitions, stale-lease reclamation,
  and concurrent-worker verification.
- **PF-042** added the persistent worker runtime with registered-type-only claims, bounded
  concurrency, long-job heartbeats, stale-lease recovery, redacted retry/permanent failure handling,
  and `SIGTERM`/`SIGINT` draining before PostgreSQL pool shutdown.
- **PF-043** registered encrypted-inbox Pluggy event processing: lifecycle handlers re-read the
  current Item and expose ACTIVE only after required import succeeds; action states create bounded,
  idempotent audit evidence for later owner surfacing; deletion retains history and stops pending
  refreshes; and created, updated, and deleted transactions are fetched only through V2,
  soft-deleted with revisions, and followed by conservative same-sync replacement detection.
- **PF-044** added an explicit-workspace one-shot scheduled reconciliation command with
  PostgreSQL-backed overlap protection, the same per-connection exclusion used by webhook work,
  bounded provider refresh observation, full V2 repair import, and connection health/freshness
  updates.
- **PF-045** added a fixed-workspace web-owner operational API for bounded sync-run and dead-letter
  inspection, controlled supported-job retry, and deduplicated manual connection reconciliation;
  the persistent worker now executes manual `SYNC_CONNECTION` jobs with audited `MANUAL` sync
  provenance.
- **PF-046** hardened lease timestamps against shortening and regression, reports lease ownership
  loss distinctly, aborts affected handlers, and proves active dedupe, exact-expiry rejection,
  stale-owner completion rejection, expired-lease reclaim, and signal-driven draining.
- **PF-050** added a versioned pure description normalizer with conservative Unicode, whitespace,
  punctuation, exact processor-prefix, likely store-suffix, installment, and transaction-reference
  handling; sanitized fixtures prove every removed fragment remains structured while transaction
  import preserves the exact original text and stores the canonical matching key.
- **PF-051** added audited, workspace-scoped canonical merchants and confirmed aliases, exact-key
  and identity-hash resolution, unambiguous high-confidence prefix/contains matching, bounded fuzzy
  review candidates, and concurrent idempotent provisional creation. A new append-only migration
  makes alias confirmation explicit and identity hashes unique within each workspace.
- **PF-052** added a versioned strict JSON condition/action DSL with only the documented fields,
  operators, and actions; field-aware values and string-only financial decimals; bounded trees,
  collections, text, regex patterns, and inputs; duplicate-action rejection; and Google RE2-WASM
  compilation for linear-time user-authored patterns. It accepts neither arbitrary code nor native
  JavaScript regular expressions.
- **PF-053** added deterministic priority/creation/ID rule evaluation with explicit conflict and
  stop reporting, workspace-validated rule creation, inactive-until-confirmed suggestions, selected
  decision persistence, system field/tag application, and fingerprint-idempotent hit counts under
  concurrent retry. Invalid stored DSL fails closed, and an append-only database guard validates
  versioned `SET_CATEGORY` actions against global or same-workspace active categories.
- **PF-054** added an explicit transaction-only versus future-application correction contract.
  Transaction-only corrections preserve optimistic `SET`, `CLEAR`, and `INHERIT` behavior without
  creating a rule; future application creates a visible inactive description/merchant suggestion,
  and only a separate audited, workspace-scoped, retry-idempotent confirmation activates it.
- **PF-055** added conservative, versioned bill-payment, internal-transfer, and refund detection.
  Bill-payment roles require normalized child/reconciliation evidence; transfers require a unique
  reciprocal cross-account match; refunds require explicit text plus a unique prior purchase. Every
  automatic or ambiguous result is fingerprinted, ambiguity remains review-only, occupied transfer
  pairs cannot be reused, and user state is never written.
- **PF-056** added a workspace-scoped classification quality report over effective user/system
  state, with fixed source buckets and exact PostgreSQL-numeric percentages. Its unclassified queue
  uses stable date/ID keyset pagination, returns only bounded normalized owner-facing fields, and
  keeps explicit user clears, missing conversions, and workspace isolation visible.
- **PF-057** added a single sanitized missing-enrichment regression across provider mapping, full
  import/re-import, deterministic rules, effective analytics, bill linkage/reconciliation, and the
  quality queue. Shared strict web-owner and bounded identifier-free MCP schemas represent absent
  category/merchant values as unclassified data; this is contract coverage, not an implemented UI
  or MCP server.

PF-003 through PF-006 are architecture-documentation milestones; executable implementation now
extends through Phase 2's database foundation, deterministic domain policy, validated provider
adapter, complete synthetic fixture matrix, explicit lifecycle mapping, and PF-030's versioned
encryption boundary plus controlled connection discovery and account, transaction, and bill import.
The persistent worker currently claims its implemented `PROCESS_WEBHOOK` and `SYNC_CONNECTION` job
types; scheduled reconciliation remains an independent terminating command, and other future queue
job handlers are not yet registered. The repository intentionally contains no product
authentication, analytics service, general financial-data repositories, product UI, or production
secrets. The next ticket is **PF-058: Currency and timezone regression suite**.

The accepted decisions are indexed in [`docs/adr/`](docs/adr/README.md). In particular, ADRs 0008
through 0010 are the implementation contracts for credential boundaries, workspace integrity, and
provider identity/bill semantics during later phases.

## Prerequisites

- Node.js `24.19.0`
- pnpm `11.22.0` through Corepack
- Git

Docker is required for local PostgreSQL and the database integration tests introduced during Phase 1.

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Use `pnpm install` rather than `--frozen-lockfile` only when intentionally updating dependencies.
Copy `.env.example` to the service-specific local environment file only when running an app, and
fill only the variables that service consumes. The example intentionally contains no values.

Start the local PostgreSQL service and confirm it is healthy:

```bash
docker compose -f infra/docker-compose.yml up -d --wait postgres
docker compose -f infra/docker-compose.yml ps
```

Use `LOCAL_DATABASE_URL=postgresql://cashcount:cashcount-local@127.0.0.1:5432/cashcount`. When
Docker runs in the Ubuntu UTM VM, first open the SSH tunnel documented in
[`infra/README.md`](infra/README.md).

Apply committed migrations explicitly; applications never migrate the database during startup:

```bash
pnpm db:check
pnpm db:migrate
pnpm db:seed
pnpm test:integration
```

After configuring the worker environment, discover and explicitly assign Pluggy Items to one
existing workspace with `pnpm --filter @cashcount/worker sync:discover --workspace
<workspace-uuid>`. The command prints only sanitized institution labels and local lifecycle states.

Run one controlled full import only after discovery and explicit assignment with `pnpm sync:full
--workspace <workspace-uuid> --connection <connection-uuid>`. The command imports accounts, V2
transactions, and bills in dependency order and prints only aggregate counts.

Run one scheduled reconciliation pass with `pnpm sync:reconcile --workspace <workspace-uuid>`.
The command serializes runs per workspace, serializes each Item against webhook processing,
requests or observes bounded provider refresh, repairs missed data through the full V2 import, and
then exits. A concurrent scheduled pass exits cleanly; any failed connection makes the command exit
nonzero after all eligible connections have been attempted. Intended local execution is 07:00,
12:00, 18:00, and 23:00 America/Sao_Paulo. Railway's fixed UTC expression is
`0 2,10,15,21 * * *`; verify the local-time mapping at deployment and do not depend on exact-minute
execution.

The integration gate creates a temporary empty PostgreSQL database, applies migrations twice to
prove idempotence, verifies the migration journal, and removes the temporary database.

Every application validates its environment at startup through `@cashcount/config`. Production
rejects the local database fallback, rejects the development authentication bypass, and detects
credential reuse wherever both trust-boundary values are visible to the process.

The API binds `WEB_TO_API_TOKEN` server-side to the single canonical `API_WORKSPACE_ID`; callers
cannot select a role or workspace. That web-owner credential alone may use `GET /v1/sync-runs`,
`GET /v1/sync-runs/:id`, `GET /v1/jobs/dead-letter`, `POST /v1/jobs/:id/retry`, and
`POST /v1/connections/:id/reconcile`. Lists are bounded to at most 100 rows, commands accept no
body, responses include request metadata, and the webhook/MCP credentials cannot substitute for
the web credential.

## Workspace

```text
apps/
  web/        configuration-validated shell; future Next.js web application
  api/        configuration-validated shell; future Fastify Finance API
  worker/     configuration-validated shell; future durable background worker
  mcp/        configuration-validated shell; future read-only MCP service
packages/
  config/     validated environment and shared configuration
  contracts/  shell for future runtime schemas and public types
  db/         Drizzle schema, migrations, and canonical financial query views; future repositories
  domain/     exact money/date types and provider-neutral transaction policy
  provider-core/    provider-neutral adapter shell
  provider-pluggy/  Pluggy adapter shell
  classification/   classification shell
  analytics/        deterministic analytics shell
  observability/    logging and metrics shell
  test-fixtures/    repository/configuration regression tests and sanitized provider fixtures
```

## Quality commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:check
pnpm test:integration
```

Read `AGENTS.md` and the implementation plan before changing code. Implement one PF ticket at a
time and do not commit real financial data or secrets.
