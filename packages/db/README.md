# Database package

`@cashcount/db` owns the PostgreSQL client, Drizzle schema source, append-only SQL migrations, and
the explicit migration runner. PF-012 adds `app_user`, `workspace`, and `workspace_member`. PF-013
adds `provider_connection`, encrypted `provider_raw_object` evidence, the workspace-aware
`webhook_event` inbox, lease-ready `job_queue`, and `sync_run`. Financial tables, repositories,
provider integration, and queue execution remain future work.

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
verify constraints and the synthetic seed, exercise PF-011 and PF-012 upgrade paths, and prove
provider identity scope, cross-workspace rejection, encrypted-envelope checks, webhook idempotency,
active queue dedupe, and lease-state constraints. Each temporary database is dropped afterward. The
database user running this CI-only test must be allowed to create and drop databases.

Provider raw objects and webhook bodies are stored only as versioned encrypted envelopes. The schema
does not implement encryption or provider calls; later write paths must use the accepted AES-256-GCM
keyring and authenticated-context contract from ADR 0007.

Drizzle `0.45.x` currently has third-party declaration errors under TypeScript 6 when dependency
declarations are checked directly. This package therefore enables `skipLibCheck` locally while all
CashCount source remains subject to the repository's strict compiler settings.

Never edit a migration that has run in production. Add a forward-only migration and use the
expand/migrate/contract release pattern instead. Journal indexes and timestamps must remain strictly
increasing so an upgrade cannot sort a new migration behind an applied one.
