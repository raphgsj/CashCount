# ADR 0008: Independent credentials for each trust boundary

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§4, 6.2, 7.4
- **Follow-up:** PF-004 expands the storage and rotation procedure

## Context

CashCount accepts calls from the Vercel BFF, Pluggy webhooks, Hermes, and the MCP service. These
callers have different capabilities and compromise risks. A shared internal secret would allow a
credential stolen from a narrow path to substitute for a more privileged caller.

## Decision

Use an independently generated credential and code path for every trust boundary.

- `WEB_TO_API_TOKEN` authorizes the Next.js server for owner web API routes.
- `PLUGGY_WEBHOOK_SECRET` authorizes only authenticated webhook inbox insertion.
- `MCP_CLIENT_TO_MCP_TOKEN` authorizes Hermes to invoke approved MCP tools.
- `MCP_TO_API_READONLY_TOKEN` authorizes only bounded read-only Finance API routes.
- Each credential maps server-side to a fixed role and workspace; callers cannot choose either.
- Credentials have at least 256 bits of securely generated entropy, rotate independently, are
  compared in constant time, and are never logged, prefixed into logs, or exposed to the browser.
- Detectable reuse is rejected when multiple boundary credentials are visible to one process.
- The worker uses repositories directly; any future worker-to-API call receives a new worker-specific
  credential.

## Alternatives considered

### One shared internal token

This reduces secret count but makes all service paths mutually substitutable and couples every
rotation to every deployment.

### Put role or workspace in a caller-controlled header

This makes authorization depend on untrusted claims rather than the credential's server-side
identity and creates an escalation path.

### Send the API service token to the browser

This avoids a BFF hop but exposes a reusable privileged secret in browser storage, bundles, or
network inspection.

### Give MCP database credentials

This bypasses API authorization and creates a broad query surface that cannot be reduced to approved
financial tools.

## Consequences

- Compromise and revocation are contained to one caller/receiver boundary.
- More secrets, guards, configuration tests, and coordinated rotation procedures are required.
- Static bearer tokens are acceptable only for the personal MVP; commercialization requires scoped,
  per-user authorization where appropriate.
- API authorization must never accept one boundary credential in place of another.

## Deferred detail

PF-004 will add the deployment storage matrix, overlap/rollback rotation sequence, and expanded
rationale for the MCP-to-API path without changing this baseline separation decision.
