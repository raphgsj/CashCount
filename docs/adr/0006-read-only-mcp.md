# ADR 0006: Separate read-only MCP service

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§4.3, 17, 30 RD-005

## Context

Hermes needs natural-language access to selected financial answers, but an agent must not receive
generic database access, raw provider records, mutation capabilities, or the web application's owner
credential. The numerical answers must use the same deterministic policy as the product API.

## Decision

Deploy `apps/mcp` as a separate Railway service after the analytics API is stable.

- Hermes authenticates to MCP with `MCP_CLIENT_TO_MCP_TOKEN`.
- MCP calls bounded Finance API routes over Railway private networking with the different
  `MCP_TO_API_READONLY_TOKEN`.
- MCP never connects to PostgreSQL, imports database repositories, uses `WEB_TO_API_TOKEN`, or
  reimplements financial calculations.
- Tools have explicit names and typed schemas and expose only reviewed read-only operations.
- Transaction detail requires bounded dates and row limits; summaries include currency, period,
  `asOf`, freshness, policy version, and relevant completeness warnings.
- The first release has no mutation, payment, raw-data, generic SQL, arbitrary fetch, filesystem,
  prompt, resource, or sampling surface.
- Workspace and role are bound to credentials server-side rather than accepted from Hermes.
- The service has independent rate limits, redacted audit logs, and a kill switch that does not
  disable the web application.

## Alternatives considered

### Give the agent read-only database credentials

Database grants cannot provide the same stable, bounded, policy-aware tool contract and would expose
schema detail and query flexibility beyond the product need.

### Let MCP share the web API credential

The web role includes owner read/write capabilities, so reuse would make the agent credential
substitutable for a more privileged caller.

### Embed MCP into the web application or Finance API

This removes a deployment, but couples agent exposure, rate limits, logs, and shutdown behavior to a
more privileged service.

## Consequences

- Agent access has a small, independently revocable attack surface.
- MCP answers reuse API calculations and authorization semantics.
- Every new agent capability requires a reviewed API route and MCP tool schema.
- The extra service and API hop add deployment work and latency.
- A later multi-user release will need OAuth 2.1 and scoped authorization instead of the personal
  static client token.

## Enforcement

Import boundaries prohibit MCP-to-database dependencies. Contract, authorization, negative-scope,
rate-limit, and audit tests must accompany tool implementation.
