# Repository Instructions

Read `personal-finance-platform-implementation-plan.md` and the relevant ADRs before changing
code. `personal-finance-platform-required-amendments.md` is retained as the incorporated decision
record; the versioned implementation plan is the canonical specification.

## Current implementation state

- Phase 0 is complete: PF-001 through PF-006.
- PF-010 is complete: executable infrastructure now includes health-checked local PostgreSQL through
  Docker Compose. PF-003 through PF-006 remain accepted architecture and integrity contracts for
  later implementation.
- The next ticket is PF-011, which introduces Drizzle and migrations. Do not imply that a database
  schema, provider integration, authentication implementation, financial logic, or product UI
  already exists.
- ADRs 0008, 0009, and 0010 define mandatory credential, workspace, provider-identity, signed-amount,
  and bill-reconciliation behavior for subsequent tickets.
- Update this section and the root README together whenever a PF ticket or phase is completed.

## Non-negotiable rules

- PostgreSQL is the source of truth.
- Never expose Pluggy secrets, API keys, raw payloads, CPF, or full account/card numbers.
- Never add payment-initiation capabilities.
- Never give an agent generic SQL access.
- Use Decimal/PostgreSQL numeric for financial arithmetic, never JavaScript floating point.
- Every workspace-owned repository method requires `workspaceId`, and PostgreSQL must reject
  cross-workspace references.
- Provider webhooks are idempotent and return quickly.
- Never write `transaction_user_state` during provider synchronization.
- Never infer a credit-card financial role from amount sign alone.
- Never combine currencies without an explicit conversion amount or documented conversion source.
- Do not invent Pluggy response fields; validate official documentation and synthetic fixtures.
- Use only Pluggy `GET /v2/transactions`, never the deprecated page endpoint.
- Treat provider category and merchant fields as optional hints.
- MCP calls the read-only Finance API and never connects directly to PostgreSQL.
- New encrypted writes use the active key version; reads use the row's stored key version.
- A queue worker may complete a job only while it owns an unexpired lease.
- Never edit a migration that has run in production.
- Never commit `.env` files, secrets, or real/pseudonymized financial payloads.

## Package boundaries

- `provider-pluggy` may depend on `provider-core`, contracts, and observability.
- `domain` never depends on a provider-specific package.
- `analytics` may depend on domain and database packages, not apps or provider-specific packages.
- `api`, `worker`, and `mcp` orchestrate packages and contain little domain logic.
- `web` consumes API contracts and never imports database code.
- Only `packages/config` and application entrypoints may read `process.env` directly.

## Work process

1. Implement one PF ticket at a time.
2. Confirm the current implementation boundary in `README.md`, then restate the selected ticket's
   acceptance criteria before coding.
3. Make the smallest coherent change.
4. Add tests before or with implementation.
5. Run format, lint, typecheck, relevant tests, and build.
6. Update `README.md` and this file when the completed ticket changes the documented implementation
   boundary or next-ticket pointer.
7. Summarize changed files, commands, exact results, and remaining risks.
8. Stop when the selected ticket is complete; do not start the next ticket or phase automatically.
