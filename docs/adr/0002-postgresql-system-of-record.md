# ADR 0002: PostgreSQL as the system of record

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§1.1, 1.4, 9, 20

## Context

CashCount must preserve provider observations, normalized financial facts, user-owned corrections,
audit history, synchronization state, and deterministic analytics. Pluggy is asynchronous and may
delete, replace, or revise objects, so querying the provider on demand cannot provide durable local
history or stable user decisions.

## Decision

Use PostgreSQL on Railway as the authoritative application data store.

- Provider data is acquired by backend services and persisted before product features consume it.
- Normalized facts, user state, revisions, jobs, and encrypted evidence have explicit relational
  schemas and constraints.
- Monetary columns use PostgreSQL `numeric`; JavaScript floating point is not used for money.
- Drizzle owns schema declarations and migrations; explicit SQL is allowed for constraints, views,
  and complex analytics.
- Migrations are append-only after production use.
- Routine UI, API, analytics, and MCP reads use normalized tables and reviewed SQL views, not raw
  provider payloads.
- Encrypted, off-platform backups and restore tests are part of operating the source of truth.

Pluggy remains the upstream source of provider observations. PostgreSQL is the source of truth for
CashCount's durable state and interpretation of those observations.

## Alternatives considered

### Read from Pluggy for each request

This avoids local persistence but loses user annotations and stable history, increases latency and
rate-limit exposure, and cannot explain provider replacement or deletion behavior.

### Document database or object storage as the primary store

These are suitable for raw evidence, but relational integrity, workspace constraints, reconciliation,
and deterministic financial queries are central requirements.

### Split operational state across PostgreSQL and a second primary datastore

This may become justified at scale, but it introduces consistency and recovery problems before a
measured bottleneck exists.

## Consequences

- Financial state is durable, queryable, auditable, and transactionally consistent.
- Database constraints can reject cross-workspace and invalid relational states.
- The application owns migrations, backup verification, connection limits, and query performance.
- PostgreSQL availability affects API, worker, analytics, and MCP data availability.
- Raw evidence needs additional application-level encryption even when platform storage is encrypted.

## Enforcement

Only backend repositories access PostgreSQL. The web and MCP applications consume the Finance API,
and production PostgreSQL remains on private networking. Schema and migration changes must satisfy
the repository's database review rules.
