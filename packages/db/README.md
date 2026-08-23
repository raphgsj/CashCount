# Database package

`@cashcount/db` owns the PostgreSQL client, Drizzle schema source, append-only SQL migrations, and
the explicit migration runner. PF-012 adds `app_user`, `workspace`, and `workspace_member`. PF-013
adds `provider_connection`, encrypted `provider_raw_object` evidence, the workspace-aware
`webhook_event` inbox, lease-ready `job_queue`, and `sync_run`. PF-014 adds accounts and history
coverage, credit-card bills and reconciliation evidence, categories and merchants, exact-numeric
provider/system transactions, separately owned transaction state, provider-identity continuity, and
transaction revisions. Repositories, provider integration, queue execution, financial policy, and
product behavior remain future work. PF-015 adds classification rules/decisions, installment and
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
verify constraints and the synthetic seed, exercise PF-011 through PF-015 upgrade paths, and prove
provider identity scope, cross-workspace rejection, encrypted-envelope checks, webhook idempotency,
active queue dedupe, lease-state constraints, category visibility/immutability, exact numeric
round-trips, transaction continuity, bill reconciliation account roles, intelligence evaluation
idempotency, series scope, tag scope, and bounded audit records. Each temporary database is dropped
afterward. They also verify effective override/provenance behavior, currency-safe spend/cash-flow
effects, reconciliation warnings, history/freshness, review queues, monthly summaries, and
installment commitments. The database user running this CI-only test must be allowed to create and
drop databases.

PF-015 replaces PF-014's temporary null-only series guard with composite workspace foreign keys to
the installment and recurring parents.

Provider raw objects and webhook bodies are stored only as versioned encrypted envelopes. The schema
does not implement encryption or provider calls; later write paths must use the accepted AES-256-GCM
keyring and authenticated-context contract from ADR 0007.

Drizzle `0.45.x` currently has third-party declaration errors under TypeScript 6 when dependency
declarations are checked directly. This package therefore enables `skipLibCheck` locally while all
CashCount source remains subject to the repository's strict compiler settings.

Never edit a migration that has run in production. Add a forward-only migration and use the
expand/migrate/contract release pattern instead. Journal indexes and timestamps must remain strictly
increasing so an upgrade cannot sort a new migration behind an applied one.
