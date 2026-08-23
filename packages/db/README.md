# Database package

`@cashcount/db` owns the PostgreSQL client, Drizzle schema source, append-only SQL migrations, and
the explicit migration runner. PF-011 configures the toolchain only; PF-012 introduces the first
application tables.

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

The integration test creates a uniquely named empty database, applies the complete migration set
twice, verifies the Drizzle journal and current PF-011 boundary, then drops the database. The
database user running this CI-only test must be allowed to create and drop databases.

Drizzle `0.45.x` currently has third-party declaration errors under TypeScript 6 when dependency
declarations are checked directly. This package therefore enables `skipLibCheck` locally while all
CashCount source remains subject to the repository's strict compiler settings.

Never edit a migration that has run in production. Add a forward-only migration and use the
expand/migrate/contract release pattern instead.
