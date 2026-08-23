# CashCount

CashCount is a private personal-finance intelligence platform. The target system imports the
owner's financial data through a provider adapter, preserves normalized history in PostgreSQL,
and exposes deterministic analytics to an authenticated web application and a read-only MCP
server.

**Phases 0 and 1 are complete, and Phase 2 is in progress through PF-023:**

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

PF-003 through PF-006 are architecture-documentation milestones; executable implementation now
extends through PF-023's database foundation, initial deterministic domain policy, validated provider
boundary, and Pluggy authentication transport. The repository intentionally contains no rule
evaluator, analytics service, general financial-data repositories, Pluggy data mapping, queue worker
implementation, product authentication, product UI, or production secrets. The next ticket is
**PF-024: Pluggy data client**.

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

The integration gate creates a temporary empty PostgreSQL database, applies migrations twice to
prove idempotence, verifies the migration journal, and removes the temporary database.

Every application validates its environment at startup through `@cashcount/config`. Production
rejects the local database fallback, rejects the development authentication bypass, and detects
credential reuse wherever both trust-boundary values are visible to the process.

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
  test-fixtures/    repository/configuration regression tests
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
