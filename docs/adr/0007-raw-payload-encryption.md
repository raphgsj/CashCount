# ADR 0007: Application-level encryption for raw provider payloads

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§7.1–7.3, 9.3, 9.10

## Context

Raw provider payloads are valuable evidence for debugging, audit, and reprocessing when mappings
change. They may also contain identifiers and financial details that are unnecessary for routine
queries. Platform disk encryption alone does not protect payloads from a database-only disclosure.

## Decision

Encrypt raw provider objects and webhook payloads in the application with AES-256-GCM and a
versioned keyring.

- Each envelope stores ciphertext, a unique random nonce, authentication tag, key version, canonical
  plaintext SHA-256, provider identity, and observation metadata.
- Canonical JSON hashing uses a versioned deterministic JCS-compatible algorithm.
- Additional authenticated data binds ciphertext to workspace, table, row, provider, entity/event,
  external identity, and key version so relocation fails authentication.
- Key material lives in Railway secrets and never in PostgreSQL, logs, browser code, or MCP output.
- Every keyring entry is canonical Base64 for exactly 32 bytes; the active positive integer version
  must exist.
- New writes use the active version. Reads select the version stored on each row.
- Rotation retains old keys, activates the new write key, re-encrypts in bounded resumable batches,
  verifies referenced versions, tests an off-platform backup, and retires a key only in a later
  deployment.
- Queryable normalized fields remain relational; sensitive identity fields are omitted, hashed, or
  separately encrypted.

## Alternatives considered

### Store raw payloads in plaintext

This maximizes reprocessing convenience but gives database readers unnecessary access to sensitive
evidence and expands incident impact.

### Rely only on platform or volume encryption

Encryption at rest protects physical media but not a database credential compromise, logical dump,
or overly broad SQL access.

### Do not retain raw payloads

This minimizes sensitivity but removes the evidence needed to investigate mapping defects, provider
schema changes, and normalization regressions.

### Use one unversioned application key

This is simpler initially, but safe rotation becomes a risky all-at-once operation and rows cannot
identify the key required for decryption.

## Consequences

- A database-only disclosure does not immediately reveal raw provider payloads.
- Historical evidence can be reprocessed and integrity-checked.
- Key backup, nonce safety, canonicalization stability, authenticated context, and rotation become
  critical operational responsibilities.
- Raw JSON cannot be queried directly without controlled decryption; normalized columns must support
  product queries.
- Losing an in-use key makes affected evidence unrecoverable.

## Enforcement

Configuration fails closed on invalid keyrings. Encryption tests must cover tampering, wrong context,
mixed key versions, active-key absence, resumable rotation, and premature retirement.
