# Database package

`@cashcount/db` owns the PostgreSQL client, Drizzle schema source, append-only SQL migrations, and
the explicit migration runner. PF-012 adds `app_user`, `workspace`, and `workspace_member`. PF-013
adds `provider_connection`, encrypted `provider_raw_object` evidence, the workspace-aware
`webhook_event` inbox, lease-ready `job_queue`, and `sync_run`. PF-014 adds accounts and history
coverage, credit-card bills and reconciliation evidence, categories and merchants, exact-numeric
provider/system transactions, separately owned transaction state, provider-identity continuity, and
transaction revisions. General repositories, queue execution, and product behavior remain future
work. PF-015 adds classification rules/decisions, installment and
recurring series, transaction tags, and bounded audit events. PF-016 adds 12 normal views rooted in
the canonical effective transaction and supporting review/reconciliation indexes. The views preserve
explicit user-null overrides, keep incompatible currencies out of totals, distinguish spending from
deposit-account cash flow, and expose unresolved evidence instead of fabricating transactions.
PF-017 validates classification-rule category codes in PostgreSQL and audits all 34 relationships
between workspace-owned tables for leading `workspace_id` columns and matching parent candidate
keys.
PF-018 adds the first deliberately narrow repository: every transaction user-state read/write
requires `workspaceId`; updates serialize on the owning transaction, distinguish missing rows from
stale versions, implement explicit `SET`/`CLEAR`/`INHERIT`, and read effective values only from the
canonical view. Provider synchronization has no user-state mutation method.
PF-019 completes the Phase 1 bill-evidence boundary. A global tolerance table is seeded only for BRL
at `0.01`; other currencies require an explicit row. Active reconciliation validates compatible
currency/amount, a two-day date window, effective bill-payment role, deposit-account outflow, and a
confirming actor for user decisions. Partial unique indexes prevent one payment or bank transaction
from participating in multiple active matches, while candidates/rejections remain retained.
PF-030 implements versioned AES-256-GCM payload encryption with exact canonical JSON hashing and
row/workspace/provider identity bound as authenticated data. It supports active-key writes,
mixed-version reads, verified re-encryption, referenced-key checks, and guarded retirement. The
append-only rotation migration records canonicalization versions, enforces 12-byte nonces and
16-byte tags, and adds durable resumable progress in `encryption_rotation_run`.
PF-031 adds explicit-workspace provider-connection assignment. PF-032 adds locked account imports
with encrypted, hash-deduplicated raw evidence and masked normalized identifiers. PF-033 adds
workspace/account-scoped transaction imports with exact values and dates, provider lifecycle
revisions, coverage and sync-run progress, and no user-state mutation surface. PF-034 adds scoped
credit-card bill, payment, and finance-charge imports with nullable provider fields, encrypted
hash-deduplicated evidence, idempotent child identities, and existing-transaction back-linking only.
PF-035 exercises those repositories together against the sanitized provider fixture matrix twice,
verifying stable normalized/raw/child counts and preservation of transaction user state.
PF-036 conservatively derives `PARTIAL` versus `PROVIDER_MAXIMUM_RETRIEVED` from the actually
observed provider date span, preserves `USER_EXTENDED_HISTORY`, and exposes a workspace-required
range query with structured `INCOMPLETE_HISTORY` warnings before the earliest known date. The same
gate hardens concurrent first user-state writes so unique races surface as typed optimistic
conflicts rather than raw database errors.
PF-037 adds same-sync provider-replacement candidates under a versioned deterministic policy. It
retains both provider rows, auto-confirms only unique high-confidence matches, keeps weak/competing
matches reviewable, and transfers user state/tags only into an empty successor while recording one
idempotent revision and audit event.

From the repository root:

```bash
pnpm db:generate
pnpm db:check
pnpm db:migrate
pnpm test:integration
```

`db:migrate` validates `DATABASE_URL`/`LOCAL_DATABASE_URL`, applies committed migrations, and closes
its pool. It is a release/development command and is never called by application startup. Production
requires `DATABASE_URL` and rejects `LOCAL_DATABASE_URL`.

`db:seed` inserts one idempotent, fully synthetic owner/workspace/membership outside production. It
uses reserved example data and refuses to run when `NODE_ENV=production`.

The integration tests create uniquely named empty databases, apply the complete migration set twice,
verify constraints and the synthetic seed, exercise every migration-bearing PF-011 through PF-019
upgrade path, and prove
provider identity scope, cross-workspace rejection, encrypted-envelope checks, webhook idempotency,
active queue dedupe, lease-state constraints, category visibility/immutability, exact numeric
round-trips, transaction continuity, bill reconciliation account roles, intelligence evaluation
idempotency, series scope, tag scope, and bounded audit records. Each temporary database is dropped
afterward. They also verify effective override/provenance behavior, currency-safe spend/cash-flow
effects, reconciliation warnings, history/freshness, review queues, monthly summaries, and
installment commitments, plus idempotent encrypted account/transaction/bill imports, exact
dual-currency round trips, provider deletion/reappearance, bill-child updates, unsupported nullable
bill fields, transaction back-linking without synthesis, and user-state isolation. The database user
running this CI-only test must be allowed to create and drop databases.

PF-015 replaces PF-014's temporary null-only series guard with composite workspace foreign keys to
the installment and recurring parents.

Provider raw objects and webhook bodies are stored only as versioned encrypted envelopes. The
encryption service and account/transaction/bill import repositories implement ADR 0007 with
active-key writes and context-bound evidence; normalized account storage retains only masked number
suffixes.

Drizzle `0.45.x` currently has third-party declaration errors under TypeScript 6 when dependency
declarations are checked directly. This package therefore enables `skipLibCheck` locally while all
CashCount source remains subject to the repository's strict compiler settings.

Never edit a migration that has run in production. Add a forward-only migration and use the
expand/migrate/contract release pattern instead. Journal indexes and timestamps must remain strictly
increasing so an upgrade cannot sort a new migration behind an applied one.
