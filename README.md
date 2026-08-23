# CashCount

CashCount is a private personal-finance intelligence platform. The target system imports the
owner's financial data through a provider adapter, preserves normalized history in PostgreSQL,
and exposes deterministic analytics to an authenticated web application and a read-only MCP
server.

**Phase 0 is complete (PF-001 through PF-006):**

- **PF-001** established the monorepo and application/package foundations.
- **PF-002** added validated application environments and production safety constraints.
- **PF-003** recorded the baseline architecture decisions in `docs/adr/`.
- **PF-004** defined credential storage, authorization boundaries, and rotation procedures.
- **PF-005** defined workspace integrity, category visibility, and repository scoping.
- **PF-006** defined provider-ID continuity, signed card semantics, and bill reconciliation.

PF-003 through PF-006 are architecture-documentation milestones; executable implementation currently
extends through PF-002. The repository intentionally contains no financial logic, database schema,
provider integration, authentication implementation, or production secrets. Phase 1 starts with
**PF-010: local PostgreSQL**.

## Prerequisites

- Node.js `24.19.0`
- pnpm `11.22.0` through Corepack
- Git

Docker is not required until PF-010 introduces local PostgreSQL.

## Setup

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
```

Use `pnpm install` rather than `--frozen-lockfile` only when intentionally updating dependencies.
Copy `.env.example` to the service-specific local environment file only when running an app, and
fill only the variables that service consumes. The example intentionally contains no values.

Every application validates its environment at startup through `@cashcount/config`. Production
rejects the local database fallback, rejects the development authentication bypass, and detects
credential reuse wherever both trust-boundary values are visible to the process.

## Workspace

```text
apps/
  web/        future Next.js web application
  api/        future Fastify Finance API
  worker/     future durable background worker
  mcp/        future read-only MCP service
packages/
  config/     validated environment and shared configuration
  contracts/  runtime schemas and public types
  db/         Drizzle schema, migrations, and repositories
  domain/     provider-neutral financial policy
  provider-core/
  provider-pluggy/
  classification/
  analytics/
  observability/
  test-fixtures/
```

## Quality commands

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Read `AGENTS.md` and the implementation plan before changing code. Implement one PF ticket at a
time and do not commit real financial data or secrets.
