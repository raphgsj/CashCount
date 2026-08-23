# Architecture decision records

Architecture decision records capture choices that constrain implementation across more than one
ticket or service. Accepted ADRs are authoritative alongside the canonical implementation plan. If a
decision changes materially, add a superseding ADR or explicitly mark and link the replaced record;
do not silently erase the original reasoning.

| ADR                                                  | Status   | Decision                                                                   |
| ---------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| [0001](0001-typescript-monorepo.md)                  | Accepted | One strict TypeScript monorepo with separately deployable applications     |
| [0002](0002-postgresql-system-of-record.md)          | Accepted | PostgreSQL is CashCount's durable system of record                         |
| [0003](0003-provider-adapter-boundary.md)            | Accepted | Provider-specific behavior stays behind a provider-neutral contract        |
| [0004](0004-postgres-backed-job-queue.md)            | Accepted | Durable jobs use PostgreSQL leases and deduplication                       |
| [0005](0005-vercel-bff-and-railway-api.md)           | Accepted | Vercel hosts the BFF; Railway hosts persistent finance services            |
| [0006](0006-read-only-mcp.md)                        | Accepted | MCP is a separate read-only API client with no database access             |
| [0007](0007-raw-payload-encryption.md)               | Accepted | Raw provider evidence uses versioned application-level encryption          |
| [0008](0008-credential-and-trust-boundaries.md)      | Accepted | Every trust boundary has a distinct fixed-capability credential            |
| [0009](0009-workspace-integrity.md)                  | Accepted | Workspace isolation is enforced in database relations and repositories     |
| [0010](0010-provider-identity-and-bill-semantics.md) | Accepted | Provider identity, continuity, and bill economics remain distinct concepts |

PF-003 established all ten baseline decisions. PF-004 expanded ADR 0008 with the concrete credential
storage, authorization, rotation, and MCP data-path model. PF-005 expanded ADR 0009 with provider
uniqueness, composite relationship, category visibility, repository-scope, and verification
contracts. PF-006 will deepen ADR 0010 without changing its accepted direction unless a later record
says so.
