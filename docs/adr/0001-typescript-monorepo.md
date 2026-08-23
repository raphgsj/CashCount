# ADR 0001: TypeScript monorepo

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§1.3, 5

## Context

CashCount has four independently deployed applications and shared configuration, contracts,
provider mapping, domain policy, analytics, observability, and test fixtures. Financial definitions
must not drift between the web application, API, worker, and MCP service. The repository also needs
one reproducible quality gate before any application or package is deployed.

## Decision

Use one Git repository and one strict TypeScript workspace managed by pinned Node.js, pnpm,
Corepack, and Turborepo versions.

- Applications live under `apps/`; reusable code lives under `packages/`.
- Runtime schemas and public types are shared rather than copied between applications.
- Package boundaries separate provider code, domain policy, persistence, analytics, and delivery.
- TypeScript strictness, ESLint boundaries, formatting, tests, and builds run from root scripts.
- Runtime inputs cross a validation boundary before becoming typed application values.
- Financial arithmetic remains Decimal/SQL based; a common language does not authorize floating
  point money calculations.

Applications remain separately deployable. The monorepo is a source and dependency boundary, not
a requirement to ship one process.

## Alternatives considered

### Separate repository per service

This gives each deployment independent history and access control, but creates contract publishing,
version skew, duplicated fixtures, and coordinated-change overhead before the product needs them.

### Multiple implementation languages

Specialized runtimes could be selected per service, but the personal MVP would duplicate financial
types, validation, tooling, and operational knowledge without a measured benefit.

### One undivided application

A single application is initially smaller, but couples browser-facing code, long-running jobs,
provider secrets, and MCP access into one trust and deployment boundary.

## Consequences

- Shared definitions can change atomically with their consumers.
- One lockfile and root quality gate make builds reproducible.
- Package ownership and import direction must be actively enforced to avoid a distributed monolith.
- A change to shared tooling can affect every workspace and therefore requires full-repository
  verification.
- Separate deployment artifacts and service-specific environment variables are still required.

## Enforcement

Workspace manifests, strict TypeScript configuration, ESLint import restrictions, service-specific
entrypoints, and `pnpm check` enforce this decision. New cross-package dependencies must respect the
boundaries in `AGENTS.md`.
