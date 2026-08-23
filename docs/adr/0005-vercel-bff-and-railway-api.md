# ADR 0005: Vercel BFF and Railway Finance API

- **Status:** Accepted
- **Date:** 2026-08-23
- **Ticket:** PF-003
- **Plan references:** §§1.1–1.2, 4, 16, 23

## Context

The browser needs an authenticated interface, while provider credentials, database access, financial
policy, and service tokens require a backend trust boundary. Long-running workers and PostgreSQL do
not fit the lifecycle of a browser-facing Vercel deployment.

## Decision

Deploy the Next.js web application to Vercel as an authenticated backend-for-frontend and deploy the
persistent Finance API, worker, cron jobs, MCP service, and PostgreSQL to Railway.

- The browser authenticates to Next.js and never receives a privileged API token.
- Server components, server actions, and protected route handlers call the Finance API with
  `WEB_TO_API_TOKEN`.
- Browser-originated code does not connect directly to Railway PostgreSQL or call privileged API
  routes.
- Financial formulas and database repositories remain behind the Railway API.
- Mutations flow browser to BFF to API; data-heavy pages default to server components.
- Production PostgreSQL remains private. Only health, authenticated API, webhook, and enabled MCP
  endpoints are public.
- Vercel previews do not point at production financial services by default.

## Alternatives considered

### Browser calls the Finance API directly

This removes one hop, but would expose or replace the service credential with a broader public auth
surface and risks duplicating policy in client code.

### Vercel connects directly to PostgreSQL

This shortens read paths, but spreads database credentials and repositories across trust boundaries
and makes worker/API policy consistency harder to enforce.

### Deploy the web application and all services as one Railway process

This simplifies platform allocation, but couples browser release cadence to persistent API and worker
lifecycles and gives up Vercel's intended Next.js hosting model.

## Consequences

- Service credentials stay in server-only environments and the browser surface remains narrow.
- API authorization, auditing, and deterministic calculations are reused by web and later MCP clients.
- Web requests incur an additional server-to-server hop.
- Vercel and Railway require coordinated environment configuration, deployment, and observability.
- Availability of the Finance API affects the web application even when Vercel itself is healthy.

## Enforcement

The web package cannot import database code. Only server-side web modules may access
`WEB_TO_API_TOKEN`, and browser artifacts and network tests must prove that privileged credentials are
absent.
