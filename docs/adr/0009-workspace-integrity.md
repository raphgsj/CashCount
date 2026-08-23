# ADR 0009: Workspace integrity in database and repository boundaries

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§1.4, 9.1–9.2, 9.11
- **Follow-up:** PF-005 expands the constraint and visibility matrix

## Context

The personal MVP starts with one owner and one workspace, but financial data is sensitive and later
commercialization may introduce multiple tenants. Adding a `workspace_id` column without enforcing
relationships would still allow cross-workspace references and unscoped repository reads.

## Decision

Make workspace scope a mandatory relational and application invariant from the first production
schema.

- Every workspace-owned parent exposes a unique `(workspace_id, id)` candidate key.
- Workspace-owned child relationships use composite foreign keys containing `workspace_id`.
- Every repository method for owned data requires a non-optional `workspaceId`; unscoped
  `getById(id)` methods are prohibited.
- Provider identities are unique within workspace and provider scope.
- User-owned categories are visible only in their workspace; built-in categories are global and have
  separately enforced codes and parent-visibility rules.
- Cross-workspace replacement, reconciliation, tag, merchant, transaction, bill, and user-state
  references are rejected by PostgreSQL rather than only filtered in application code.
- Credentials map to a fixed workspace server-side; public callers do not submit an authoritative
  workspace identity.

## Alternatives considered

### Omit workspaces until a second user exists

This keeps the first schema smaller but forces invasive key, uniqueness, repository, and migration
changes after real financial data exists.

### Store `workspace_id` and rely on query filters

Filters are necessary but do not stop a defect or manual write from creating cross-workspace foreign
keys that later queries cannot interpret safely.

### Rely only on PostgreSQL row-level security

RLS can become defense in depth, but it does not replace composite referential integrity, explicit
repository APIs, or correct global-category visibility rules.

## Consequences

- The database rejects a major class of tenant-isolation failures.
- A later multi-workspace transition starts from compatible identities and relationships.
- Primary/candidate keys, foreign keys, indexes, fixtures, and repository signatures are more verbose.
- Every integration test and data migration must carry explicit workspace context.
- Global and workspace-scoped entities require deliberate uniqueness and visibility rules.

## Deferred detail

PF-005 will enumerate the full composite-foreign-key coverage, provider uniqueness rules, category
visibility constraints, and mandatory repository test matrix.
