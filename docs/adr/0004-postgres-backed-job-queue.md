# ADR 0004: PostgreSQL-backed durable job queue

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§9.3, 11, 18

## Context

Webhook processing, provider synchronization, normalization, classification, and rebuild work are
asynchronous and must survive process restarts. Jobs need transactionally safe deduplication,
bounded retries, dead-letter visibility, graceful shutdown, and protection from stale workers.

## Decision

Store durable jobs in PostgreSQL and run a persistent Railway worker.

- Claims use `FOR UPDATE SKIP LOCKED` and `UPDATE ... RETURNING` in one transaction.
- Active work is protected by an expiring lease and periodic heartbeat.
- A worker may complete a job only while it owns the lock, the job is `RUNNING`, and the lease has
  not expired.
- Expired work may be reclaimed with incremented attempts and bounded backoff.
- An active partial unique index enforces workspace, job-type, and dedupe-key uniqueness.
- Payloads contain internal identifiers only; raw provider data and secrets remain in encrypted
  storage.
- Retry policy distinguishes transient, deterministic validation, user-action, and permanent errors.
- Exhausted work remains queryable as `DEAD` for repair and controlled replay.
- Workers stop claiming on `SIGTERM` and either finish an owned unit or let its lease expire.

The initial defaults are a 120-second lease and a 30-second heartbeat unless a job type documents a
different bounded value.

## Alternatives considered

### In-memory jobs or cron-only processing

This is operationally small but loses work on restart, makes deduplication fragile, and cannot expose
reliable retry or dead-letter state.

### Redis-backed queue

Redis queue libraries provide mature scheduling and worker features, but add another stateful service
and make atomic coordination with PostgreSQL domain writes harder for the MVP.

### Managed message broker

A broker may be appropriate at larger scale, but introduces delivery semantics, credentials, cost,
and operational surface before throughput justifies it.

## Consequences

- Jobs and related application state can be committed transactionally.
- The MVP has no additional queue datastore to operate or restore.
- Polling, retries, leases, and dead-letter tooling must be implemented and tested correctly.
- Queue load competes with application queries and requires indexes, bounded concurrency, and
  monitoring.
- A future broker migration must preserve dedupe and ownership semantics.

## Enforcement

The queue repository is the only claim/complete path. Integration tests must cover concurrent claims,
lease expiry, stale-owner completion, deduplication, retries, and graceful recovery.
