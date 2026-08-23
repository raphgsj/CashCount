# ADR 0003: Provider adapter boundary

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§1.4, 5.1, 10, 29.3

## Context

The personal MVP uses Pluggy, but provider payloads, identifiers, lifecycle states, and API behavior
are not stable domain contracts. Analytics and user-owned state must survive provider changes, and a
future commercial product may use a different Open Finance provider.

## Decision

Place all Pluggy-specific behavior in `packages/provider-pluggy` behind contracts defined by
`packages/provider-core`.

- Provider responses are validated before mapping to provider-neutral DTOs.
- DTOs preserve signed amounts, currencies, timestamps, nullable enrichment, provider type and
  operation fields, bill metadata, and stable external identifiers without becoming database rows.
- Money crosses the adapter as validated decimal strings.
- The adapter owns authentication, HTTP reliability, cursor pagination, webhook schemas, lifecycle
  normalization, and response mapping.
- The adapter has no database access and contains no category, spend, or accounting policy.
- Domain commands and repositories consume normalized DTOs; analytics never depend on Pluggy field
  names.
- Pluggy transaction retrieval uses the cursor-based `GET /v2/transactions` endpoint only.
- Original validated payloads remain encrypted evidence for reprocessing and schema investigation.

The provider-neutral model preserves meaningful facts instead of collapsing every provider into a
lowest-common-denominator transaction.

## Alternatives considered

### Use Pluggy payloads throughout the application

This is faster for the first import but couples schema, analytics, UI, and tests to one provider and
makes provider changes dangerous.

### Map provider responses directly into database rows

This removes one transformation, but mixes transport validation, provider semantics, persistence,
and domain policy in the same code path.

### Delay the abstraction until a second provider is selected

That avoids an early interface, but the boundary is also needed now to isolate unstable external
data and keep deterministic policy provider-neutral.

## Consequences

- Provider API changes are localized and contract-testable.
- A future adapter can reuse domain commands, persistence, and analytics.
- Mapping code and synthetic provider fixtures add implementation cost.
- Provider-specific evidence must sometimes be retained alongside normalized fields.
- The neutral DTOs must evolve carefully when a provider exposes a financially meaningful concept.

## Enforcement

Import rules prohibit domain packages from depending on `provider-pluggy`. Adapter tests use
sanitized synthetic fixtures, and provider DTOs are validated before any persistence command runs.
