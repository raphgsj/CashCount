# CashCount

CashCount is a private personal-finance intelligence platform. The target system imports the
owner's financial data through a provider adapter, preserves normalized history in PostgreSQL,
and exposes deterministic analytics to an authenticated web application and a read-only MCP
server.

The repository is currently at **PF-001: repository foundation**. It intentionally contains no
financial logic, database schema, provider integration, authentication, or production secrets.

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
