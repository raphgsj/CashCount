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
- PF-042 adds the persistent worker runtime with registered-type-only claims, bounded concurrency,
  lease heartbeats, stale-lock recovery, redacted failure disposition, signal-driven claim shutdown,
  in-flight draining, and PostgreSQL pool release. At that ticket boundary no handlers were
  registered.
- PF-043 adds encrypted inbox processing and registered Pluggy lifecycle/transaction handlers with
  current-Item reads, post-import ACTIVE transitions, owner-action audit evidence, V2-only created,
  updated, and deleted transaction processing, scoped soft deletion/revisions, and replacement
  detection. Deleted connections preserve history and terminate pending refresh work.
- PF-044 adds an explicit-workspace, terminating scheduled reconciliation command with
  PostgreSQL-backed workspace overlap protection, webhook-shared per-connection exclusion, bounded
  provider refresh observation, full V2 repair import, and connection health/freshness updates.
- PF-045 adds a fixed-workspace web-owner operational API for bounded sync-run/dead-letter reads,
  controlled supported-job retry, and deduplicated manual reconciliation. The persistent worker
  executes `SYNC_CONNECTION` through the shared reconciliation path with `MANUAL` sync provenance.
- PF-046 completes Phase 4 with monotonic lease timestamps, distinct lost-lease signaling and
  handler cancellation, and database-backed proof of running-job dedupe, exact-expiry rejection,
  expired-lease reclaim, stale-owner completion rejection, and graceful signal-driven draining.
- PF-050 starts Phase 5 with a versioned pure description normalizer that conservatively handles
  Unicode, punctuation, exact processor prefixes, likely store suffixes, installment metadata, and
  transaction references. Sanitized fixtures prove removed fragments remain structured, and
  transaction import preserves original text while storing the canonical matching key.
- PF-051 adds audited workspace-scoped canonical merchants and explicitly confirmed aliases, exact
  key and identity-hash resolution, unambiguous high-confidence pattern matching, bounded fuzzy
  review candidates, and concurrency-safe provisional merchants. PostgreSQL enforces workspace-
  unique non-null identity hashes, and unconfirmed aliases fail closed.
- PF-052 adds a versioned, strict condition/action DSL over the documented field and operator
  vocabulary. It uses string-only decimals, bounded trees/lists/text/patterns, field-aware values,
  non-conflicting actions, and Google RE2-WASM for linear-time user-authored regular expressions;
  arbitrary code and JavaScript regular expressions are not accepted.
- PF-053 adds deterministic priority/creation/ID rule evaluation, explicit lower-precedence and tag
  conflict reporting, stop semantics, workspace-validated rule writes, selected decisions, system
  field/tag application, and fingerprint-idempotent hit counts under concurrent retry. Invalid
  stored DSL fails closed, suggestions remain inactive, and an append-only database guard enforces
  the versioned `SET_CATEGORY` workspace invariant even when SQL bypasses the repository.
- PF-054 adds an explicit manual-correction application choice: transaction-only changes use the
  existing optimistic `SET`, `CLEAR`, and `INHERIT` state operations without creating rules, while
  future application creates a visible inactive description/merchant rule suggestion. A separate,
  audited, workspace-scoped confirmation is the only activation path and is retry-idempotent.
- PF-055 adds conservative versioned financial-role detection: bill payments require normalized
  child/reconciliation evidence, transfers require unique reciprocal cross-account evidence, and
  refunds require explicit text plus a unique prior purchase. Results are fingerprint-idempotent,
  ambiguous matches remain review-only, occupied pairs are immutable, and user state is untouched.
- PF-056 adds a workspace-scoped effective classification quality report with fixed source buckets,
  PostgreSQL-numeric percentages, and a bounded stable-keyset unclassified queue. Explicit user
  clears and missing-conversion warnings remain visible; no provider identity or raw payload is
  exposed.
- PF-057 adds an end-to-end sanitized regression proving nullable category/merchant behavior across
  provider mapping, import/re-import, deterministic rules, analytics, bill reconciliation, and the
  quality queue. Shared strict web-owner and bounded identifier-free MCP schemas treat missing
  enrichment as unclassified data; they do not implement either later service.
- PF-058 completes Phase 5 with dual-currency and timezone regression coverage for exact original
  and account-currency values, explicit unconverted warnings, UTC/local boundaries, and non-São-
  Paulo workspaces through shared consumer contracts.
- PF-060 starts Phase 6 with Fastify, request-identified liveness/database readiness, bounded
  problems, development-only generated OpenAPI, and independent fixed-workspace web-owner,
  MCP-read-only, and webhook credential guards with cross-boundary rejection.
- PF-061 adds bounded fixed-workspace web-owner reads for accounts, cards, bills, payments, and
  finance charges with exact decimal-string contracts, workspace-required repositories, and no
  provider/raw/full-number exposure. Reconciliation and installment routes remain deferred.
- PF-062 adds fixed-workspace web-owner transaction list/detail/update endpoints with filter-bound
  stable cursors, exact signed money, effective provenance/override state, owner notes/review/tags,
  bill/replacement context, structured warnings, and atomic optimistic corrections. Provider fields
  remain immutable and private.
- PF-063 adds bounded fixed-workspace web-owner category, merchant, and classification-rule
  management. Global categories are immutable; merchant merges are transactional, workspace-safe,
  alias-preserving, reference-rewiring, and audited; strict rules can be managed and prospectively
  tested without decision or hit-count mutations; deletion retains evidence by deactivating rules.
- PF-064 adds fixed-workspace spending and deposit-account cash-flow analytics over canonical
  effective views, with exact decimal strings separated by currency and posted/pending status,
  effective user overrides, policy version, freshness, and applicable history, conversion,
  reconciliation, stale-data, and connection-attention warnings. Web-owner and MCP-read-only
  credentials are accepted only through their distinct guards.
- The next ticket is PF-065, which adds period comparison. Do not imply that period comparison,
  bill workflow endpoints, commitments, recurring/anomaly/forecast features, end-user OAuth/session
  authentication, or product UI exist.
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
