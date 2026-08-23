# ADR 0009: Workspace integrity in database and repository boundaries

- **Status:** Accepted
- **Date:** 2026-08-23
- **Tickets:** PF-003; expanded by PF-005
- **Plan references:** §§1.4, 7.4, 9.1–9.11, 15.9, 22.3

## Context

The personal MVP starts with one owner and one workspace, but financial data is sensitive and later
commercialization may introduce multiple tenants. Adding a `workspace_id` column without enforcing
relationships would still allow a row in one workspace to reference data in another. Filtering only
at an HTTP or repository boundary would not prevent an incorrect worker, migration, or manual write
from creating an invalid relationship.

CashCount also has two deliberate mixed-scope cases. Categories may be built in and global or custom
and workspace owned. Webhook inbox rows and system jobs may temporarily have no workspace while the
system resolves an external identity. These exceptions need narrower contracts; they do not justify
optional workspace scope throughout the model.

## Decision

Make workspace scope a mandatory relational and application invariant from the first production
schema.

1. Provider identities are unique within workspace and provider scope, never globally.
2. Every workspace-owned parent exposes a unique `(workspace_id, id)` candidate key.
3. Every relationship between workspace-owned rows carries `workspace_id` in a composite foreign
   key. Duplicating the column without the composite constraint is insufficient.
4. Category scope is validated in PostgreSQL, including parent visibility and every category
   reference; application filtering is defense in depth only.
5. Every repository operation on workspace-owned data requires a non-optional `workspaceId` and
   includes it in its SQL predicate or inserted relationship.
6. Authenticated principals map to a fixed workspace server-side. A caller-supplied workspace ID can
   narrow a request only after it equals that binding; it can never establish authority.

Row-level security may be added as defense in depth during commercialization, but it does not replace
these keys, foreign keys, validation functions, or repository contracts.

## Provider identity and uniqueness

External identifiers are namespaced by both local workspace and provider. The initial schema must
enforce this matrix:

| Entity                  | Required identity constraint                                                | Notes                                                        |
| ----------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Provider connection     | `UNIQUE (workspace_id, provider, external_connection_id)`                   | The same external ID may exist in another workspace/provider |
| Financial account       | `UNIQUE (workspace_id, provider, external_account_id)`                      | Account identity is not global                               |
| Credit-card bill        | `UNIQUE (workspace_id, provider, external_bill_id)`                         | Bill identity remains provider scoped                        |
| Financial transaction   | Partial unique `(workspace_id, provider, provider_transaction_id)`          | Applies only when the provider ID is non-null                |
| Bill payment child      | `UNIQUE (workspace_id, credit_card_bill_id, provider, external_payment_id)` | Child identity is also bill scoped                           |
| Bill finance-charge row | Equivalent workspace/bill/provider/external-charge uniqueness               | Exact constraint lands with the child schema                 |

Encrypted raw objects are observations rather than current identities, so repeated snapshots of the
same external object remain legal. Their lookup index includes workspace, provider, entity type,
external ID, and descending observation time.

Provider synchronization must resolve the workspace from a stored connection/account relationship.
It must not accept an authoritative workspace from a provider payload. An unmapped webhook is stored
in its explicitly nullable inbox scope until repaired; it cannot be used to query or mutate tenant
financial data.

## Composite foreign-key coverage

Every workspace-owned table with a surrogate `id` adds `UNIQUE (workspace_id, id)`. A child then
references both values, for example:

```sql
FOREIGN KEY (workspace_id, financial_account_id)
REFERENCES financial_account (workspace_id, id)
```

The initial schema must apply that pattern to at least the following relationship families. A new
workspace-owned relationship is subject to the same rule even when it is not named here.

| Parent                          | Child or referencing row                                      |
| ------------------------------- | ------------------------------------------------------------- |
| Workspace                       | Provider connections, user-owned entities, and workspace jobs |
| Provider connection             | Financial accounts and sync runs                              |
| Financial account               | Credit-card bills and financial transactions                  |
| Credit-card bill                | Transactions, bill payments, and bill finance charges         |
| Financial transaction           | User state, revisions, classification decisions, and tags     |
| Financial transaction           | Transfer pairs and predecessor/successor identity links       |
| Financial transaction           | Bill-payment and finance-charge matches                       |
| Bill payment                    | Bill-payment reconciliation candidates                        |
| Merchant                        | Merchant aliases, transaction assignments, and overrides      |
| Tag                             | Transaction-tag joins                                         |
| Classification rule             | Decisions or other workspace-owned rule results               |
| Installment or recurring series | Their linked financial transactions                           |
| Workspace-owned budget          | Budget lines and other owned budget children                  |

Self-references use the same composite pattern. A transfer pair cannot cross workspaces; both sides
of a replacement link must equal the link's workspace; and a reconciliation row must share a
workspace with both its bill evidence and financial transaction.

Nullable references may omit the referenced ID, but a non-null ID must resolve through its composite
workspace foreign key. Referential actions default to `RESTRICT`/`NO ACTION` where deletion could
erase financial evidence or user state. Provider deletion uses lifecycle status and soft deletion
rather than cascading removal.

The schema and migration review for every new owned foreign key must answer both questions:

- Does the parent expose `(workspace_id, id)` as a candidate key?
- Does the child reference `(workspace_id, parent_id)`, with an integration test proving a
  cross-workspace value is rejected?

## Category uniqueness and visibility

`category.workspace_id IS NULL` means built in; a non-null value means workspace owned. PostgreSQL
must enforce separate code namespaces:

```sql
CREATE UNIQUE INDEX category_builtin_code_uq
ON category (code)
WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX category_workspace_code_uq
ON category (workspace_id, code)
WHERE workspace_id IS NOT NULL;
```

Custom codes are generated as `custom.<uuid>` and are immutable. Built-in codes cannot use the
`custom.` namespace. This prevents a custom category from impersonating a stable built-in analytics
code while allowing display names to change freely.

Because a category reference can legally target either a global row or a same-workspace row, an
ordinary composite foreign key alone cannot express the full rule. The initial migration therefore
uses foreign keys for category existence plus a shared database validation function and triggers (or
an equivalently strong PostgreSQL mechanism) that enforce:

- a built-in category has no workspace and may have only a built-in parent;
- a workspace category may have a built-in parent or a parent in the same workspace;
- a transaction, merchant default, user override, budget line, or rule in Workspace A may reference
  only a built-in category or a category in Workspace A;
- cross-workspace category assignment fails even when application validation is bypassed;
- changing the workspace or parent of a referenced category cannot make existing relationships
  invalid. Category scope and code are therefore immutable after creation; retirement uses
  `is_active`.

Classification-rule category actions stored in validated JSON do not escape this invariant. The
database write path must resolve and validate their category code/ID within the rule's workspace (or
store a normalized validated reference) before accepting the rule.

Category reads use the visibility predicate:

```sql
workspace_id IS NULL OR workspace_id = :workspace_id
```

This predicate is for correct results; the database constraints and validation triggers remain the
protection against invalid writes.

## Repository scoping contract

Every repository method that reads or mutates workspace-owned data takes `workspaceId` as a required
argument. The preferred call shape makes the scope visually unavoidable:

```ts
getTransactionById(workspaceId, transactionId);
updateTransactionUserState(workspaceId, transactionId, patch);
listTransactions(workspaceId, filters, cursor);
```

Unscoped forms such as `getTransactionById(id)`, `findAccountByExternalId(provider, externalId)`, or
generic `listAll()` are prohibited. This applies to reads, inserts, upserts, updates, deletes, bill
lookups, merchant merges, rule evaluation, jobs, exports, and analytics.

Repository implementation rules:

- selects, updates, and deletes include `workspace_id = :workspaceId` even when filtering by a
  globally unique UUID;
- inserts take the workspace from the trusted service context and include it in all composite
  relationships;
- provider lookups include workspace and provider as well as the external ID;
- multi-row operations and transactions cannot mix workspace contexts;
- not-found and wrong-workspace lookups expose the same bounded result;
- web and MCP code never receives a database repository; API/worker orchestration passes the
  server-bound workspace explicitly;
- tests use at least two workspaces so an accidentally unscoped query is observable.

The only nullable-workspace repositories are narrowly named infrastructure paths for unmapped
webhook ingestion and system job administration. They accept a system capability rather than a
tenant credential, expose no generic financial-data lookup, and require an explicit mapping step
before a handler can touch workspace-owned data. They are not overloads of tenant repositories.

## Verification matrix

PF-017 must implement the constraints and test them against real PostgreSQL. At minimum, tests must
prove:

- provider identifiers can repeat across workspaces but not inside the same workspace/provider;
- every relationship family above rejects a parent ID from another workspace;
- built-in categories are visible everywhere and can have only built-in parents;
- custom categories and their parents/references remain inside their workspace;
- rule category actions cannot bypass category visibility;
- repository reads and mutations return or affect only their required workspace;
- a caller-provided workspace cannot override its authenticated server-side binding;
- unmapped webhook/system-job paths cannot read or mutate tenant financial data.

Static tests and review should reject exported unscoped repository methods. Database integration
tests use PostgreSQL rather than an in-memory substitute because the composite keys, partial indexes,
and visibility triggers are part of the product's security boundary.

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

### Make provider IDs globally unique

This assumes an external namespace CashCount does not control and prevents independent workspaces
from storing legitimately identical provider identifiers.

## Consequences

- PostgreSQL rejects a major class of tenant-isolation failures before data can become inconsistent.
- A later multi-workspace transition starts from compatible identities and relationships.
- Candidate keys, foreign keys, indexes, triggers, fixtures, and repository signatures are more
  verbose.
- Every integration test and data migration carries explicit workspace context.
- Global and workspace-scoped categories require deliberate write validation and immutable scope.
- System/unmapped processing uses separate narrow repositories instead of weakening all tenant
  repositories.

## Enforcement and follow-up

- PF-010 and PF-011 provide PostgreSQL and the migration toolchain.
- PF-012 through PF-016 create the identity, provider, financial, intelligence, view, and index
  foundations using this contract.
- PF-017 is not complete until the full composite-key and category-visibility test matrix passes.
- Later repository tickets must preserve the required `workspaceId` API and add two-workspace tests
  with every new owned relationship.
