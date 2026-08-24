# Repository Instructions

Read `personal-finance-platform-implementation-plan.md` and the relevant ADRs before changing
code. `personal-finance-platform-required-amendments.md` is retained as the incorporated decision
record; the versioned implementation plan is the canonical specification.

## Current implementation state

- Phase 0 is complete: PF-001 through PF-006.
- Phase 1 is complete: PF-010 through PF-019. Executable infrastructure includes health-checked local
  PostgreSQL, Drizzle tooling, an explicit migration runner, migration-from-zero/upgrade CI
  verification, the identity/workspace schema with a synthetic local seed, and the provider/sync
  schema with encrypted evidence envelopes, webhook/queue dedupe, leases, and sync runs. The
  financial core schema covers accounts/history, bills and reconciliation evidence,
  categories/merchants, provider/system transactions, user state, identity links, and revisions.
  The intelligence schema adds rules/decisions, installment and recurring series, transaction tags,
  and bounded audit events. Initial normal views provide effective transactions, currency-safe
  spend/cash-flow effects, bill/history/freshness/review summaries, monthly rollups, and installment
  commitments. Composite workspace relationships are catalog-audited, and classification-rule
  category actions are database-validated against global or same-workspace visibility. PF-003
  through PF-006 remain accepted architecture and integrity contracts for later implementation.
  Transaction user state has a workspace-required repository with explicit override modes,
  optimistic concurrency, and canonical effective reads. Bill evidence uses configurable currency
  tolerances, one active match per payment/bank transaction, and validated count-once reconciliation.
- PF-020 starts Phase 2 with Decimal-backed money, string-only monetary JSON, signed amount
  evidence, strict bank dates/bill months, and arbitrary-IANA-timezone local-date derivation.
- PF-021 adds account-aware direction/role classification and separate, count-once spending and
  deposit cash-flow effects with mixed-currency/unresolved-evidence warnings.
- PF-022 adds strict provider-neutral runtime contracts for lifecycle, accounts, signed amounts,
  nullable enrichment, credit-card metadata, bill children, cursor pages, and the provider interface.
- PF-023 adds server-side Pluggy API-key creation, expiration-aware in-memory caching, one-refresh
  concurrency, one-time 401 recovery, and structurally redacted HTTP metadata logging.
- PF-024 adds validated Item/account/bill/V2-transaction retrieval, lossless provider-number mapping,
  bounded safe-read retries/timeouts, cursor validation, and legacy webhook-hint normalization.
- PF-025 adds the complete sanitized Pluggy fixture matrix and verifies signs, currencies, nullable
  enrichment, lifecycle edges, bill children, observed history bounds, and replacement evidence at
  the provider-neutral adapter boundary.
- PF-026 completes Phase 2 with an explicit Pluggy Item lifecycle mapper covering transitive,
  success/partial-success, user-input/action, credential/consent, provider-error, deletion,
  precedence-conflict, and unknown fail-closed cases.
- PF-030 starts Phase 3 with versioned context-bound AES-256-GCM encryption, exact canonical JSON
  hashing, active-key writes/mixed-version reads, fail-closed tamper and retirement checks, strict
  database envelopes, and durable resumable rotation progress.
- PF-031 adds explicit-workspace Pluggy connection discovery with preflight workspace validation,
  atomic normalized assignment, disabled-state preservation, and safe-label-only output.
- PF-032 adds workspace-scoped account import with locked connection revalidation, encrypted and
  hash-deduplicated raw evidence, exact normalized values, masking-only identifiers, and idempotent
  upserts.
- PF-033 adds bounded V2 cursor exhaustion, encrypted and hash-deduplicated transaction evidence,
  exact signed dual-currency/local-date persistence, scoped bill references, provider-ID lifecycle
  revisions, conservative duplicate review, coverage updates, and sync counters while never writing
  transaction user state.
- PF-034 adds workspace-scoped bill import with active-key encrypted and hash-deduplicated bill,
  payment, and finance-charge evidence, nullable unsupported fields, idempotent child upserts, and
  transaction back-linking without synthesizing financial transactions.
- PF-035 adds an explicit-workspace/connection full-import command and repeated sanitized
  account→transaction→bill regression coverage proving normalized/raw/bill-child idempotence and
  user-state preservation.
- PF-036 adds conservative per-account provider-history assessment, owner-extended coverage
  preservation, and workspace-scoped range warnings whenever a request predates actual known
  coverage. Concurrent first user-state writes now resolve losers as typed optimistic conflicts.
- PF-037 completes Phase 3 with versioned deterministic replacement scoring, same-sync eligibility,
  ambiguity-aware review links, explicit confirmation/rejection, and idempotent conflict-safe
  transfer of user state/tags with revision and audit evidence.
- PF-040 starts Phase 4 with an isolated constant-time webhook guard, bounded streaming JSON,
  official first-wave schemas, encrypted mapped/unmapped transactional inbox persistence, and one
  internal-ID-only job per event while keeping provider calls off the response path.
- PF-041 adds the capability-gated PostgreSQL queue repository with workspace/system enqueue,
  UUID-only payloads, active dedupe, atomic `SKIP LOCKED` claims, heartbeats, ownership/expiry checks,
  bounded retries, dead-lettering, and stale-lease reclamation under concurrent workers.
- The next ticket is PF-042, which adds the persistent worker process. Do not imply that event
  handlers, product authentication, rule evaluation, analytics services, general repositories, or
  product UI exist.
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
