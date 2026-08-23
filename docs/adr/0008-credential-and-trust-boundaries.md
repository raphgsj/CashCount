# ADR 0008: Independent credentials for each trust boundary

- **Status:** Accepted
- **Date:** 2026-08-23
- **Tickets:** PF-003; expanded by PF-004
- **Plan references:** §§4, 6.2, 7.4, 15.9, 17, 27.5

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

## Credential role and storage matrix

Production values are entered directly into the platform secret stores. Repository files,
`.env.example`, CI output, logs, browser code, Terraform state without secret protection, tickets,
prompts, and chat messages never contain them.

| Credential                  | Raw value held by caller          | Verification value held by receiver | Bound identity                                 | Allowed surface                         |
| --------------------------- | --------------------------------- | ----------------------------------- | ---------------------------------------------- | --------------------------------------- |
| `WEB_TO_API_TOKEN`          | Vercel web server environment     | Railway API environment             | `service_web`, fixed workspace                 | Owner web read/write API routes         |
| `PLUGGY_WEBHOOK_SECRET`     | Pluggy webhook configuration      | Railway API environment             | `service_webhook`, mapped workspace when known | Transactional webhook inbox insert only |
| `MCP_CLIENT_TO_MCP_TOKEN`   | Hermes host protected environment | Railway MCP environment             | Approved personal MCP client                   | Allow-listed read-only MCP tools        |
| `MCP_TO_API_READONLY_TOKEN` | Railway MCP environment           | Railway API environment             | `service_mcp_readonly`, fixed workspace        | Bounded read-only Finance API routes    |

The API receives the web, webhook, and MCP-read verification values because it terminates those
boundaries. It does not receive the Hermes-to-MCP token. MCP receives only its client token and its
read-only API token. Vercel receives only the web-to-API token. This least-privilege distribution is
also the detectable-reuse boundary: the API rejects equality among its three tokens, MCP rejects
equality between its two tokens, and the operator must ensure global uniqueness for values that no
single process can compare.

The browser receives none of these values. `NEXT_PUBLIC_` variables are public by definition and can
never carry a credential.

## Authorization binding and verification

Authentication produces a server-owned principal; it does not trust identity claims from request
headers, query parameters, or bodies.

| Guard                            | Accepted credential         | Principal                                                          | Explicitly forbidden                                                  |
| -------------------------------- | --------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `requireWebOwnerCredential`      | `WEB_TO_API_TOKEN`          | `service_web` plus the configured workspace                        | Webhook-only routes, MCP substitution, caller-selected role/workspace |
| `requirePluggyWebhookCredential` | `PLUGGY_WEBHOOK_SECRET`     | `service_webhook`; workspace derived from mapped provider identity | General API reads/writes, caller-selected workspace                   |
| `requireMcpReadOnlyCredential`   | `MCP_TO_API_READONLY_TOKEN` | `service_mcp_readonly` plus the configured workspace               | Mutations, admin/sync commands, raw data, notes, unbounded detail     |
| MCP client guard                 | `MCP_CLIENT_TO_MCP_TOKEN`   | Approved personal MCP client                                       | Direct API or database access, non-allow-listed MCP capabilities      |

Each guard has a distinct code path and route allow-list. No generic "internal token" guard tries all
credentials and then accepts the caller on every internal route.

Bearer parsing is strict. For comparison, hash both the presented token and each configured candidate
to a fixed-length SHA-256 digest, then use a constant-time byte comparison. High-entropy tokens make
offline guessing infeasible; hashing also avoids length-dependent comparison behavior. Missing,
malformed, expired/retired, and incorrect credentials receive the same bounded authentication error.
Neither authentication errors nor audit records include token values, prefixes, hashes, or derived
fingerprints.

Successful authorization records only safe metadata such as request ID, guard/role, route, fixed
workspace ID when appropriate, outcome, and a separately assigned rotation ID. It never records the
secret used.

## Rotation protocol

### Invariants

- Rotate one boundary credential at a time unless responding to a broader incident.
- Generate a new independent token from at least 32 cryptographically random bytes; never derive it
  from the retiring value or reuse another credential.
- Steady state has one accepted token. During a planned rotation, the receiver may accept the current
  token and at most one retiring token for a documented, time-bounded deployment window.
- Both accepted values map to exactly the same fixed principal; overlap never expands capability.
- Detectable-reuse validation covers active and retiring values visible to the process.
- Audit metadata uses a random rotation ID that is not derived from a token.

The exact secret variable or platform mechanism for the temporary secondary slot is an implementation
detail of the authentication guards. Dual acceptance must exist before production claims
zero-downtime token rotation; it must not become a permanent second credential.

### Planned sequence

1. Name the boundary, caller, receiver, owner, rotation ID, expiry deadline, verification request, and
   rollback point without recording either token.
2. Generate the replacement through a cryptographically secure tool and place it only in the caller
   and receiver secret stores that require it.
3. Deploy the receiver first so it accepts both current and replacement values on the same guard.
4. Prove the old caller still works, the replacement works on the intended surface, and the
   replacement fails on every other guard.
5. Switch the caller or external provider to the replacement and verify a real bounded request plus
   expected authorization/audit metadata.
6. Observe for the documented overlap window, then remove the retiring value from the receiver.
7. Prove the replacement still succeeds and the retired value now fails; remove the retired value
   from remaining secret stores and close the rotation record.

Boundary-specific order is receiver first, caller second:

| Boundary          | Receiver overlap deployment | Caller switch                          | Final revocation                                     |
| ----------------- | --------------------------- | -------------------------------------- | ---------------------------------------------------- |
| Web to API        | Railway API web guard       | Vercel web environment and deployment  | Remove old value from API, then Vercel               |
| Pluggy to webhook | Railway API webhook guard   | Pluggy webhook configuration           | Remove old value from API and provider configuration |
| Hermes to MCP     | Railway MCP client guard    | Hermes protected environment           | Remove old value from MCP, then Hermes               |
| MCP to API        | Railway API MCP guard       | Railway MCP environment and deployment | Remove old value from API, then MCP                  |

Before final revocation, rollback means switching the caller back to the still-accepted prior value
and diagnosing the replacement. After final revocation, reintroducing the retired token requires a
new approved rotation action; generating a third value is preferred. If compromise is suspected,
disable the affected route or service as needed, revoke the suspected value immediately, accept
temporary downtime, and never roll back to it.

Rotations verify negative scope as well as availability: a new MCP token must fail web and webhook
guards, for example. The later operational runbook records platform-specific commands and evidence,
while this ADR defines the invariant sequence.

## Why MCP calls the read-only Finance API

A PostgreSQL role marked read-only is still the wrong authorization boundary for an agent. Database
access would expose table shape, internal identifiers, potentially sensitive columns, flexible joins,
and unbounded query cost. It would bypass API guarantees that are part of financial correctness and
privacy:

- fixed credential-to-workspace binding;
- route and capability allow-lists;
- deterministic effective views and policy-versioned calculations;
- bounded date ranges, pagination, and row counts;
- omission of notes, raw/provider identifiers, and unnecessary PII;
- freshness, incomplete-history, currency, and reconciliation warnings;
- consistent redaction, rate limits, request IDs, and audit events.

Therefore `apps/mcp` may share public contracts with the API but never database repositories. It uses
`MCP_TO_API_READONLY_TOKEN` over Railway private networking and exposes only typed read-only tools.
This additional hop is deliberate: it keeps the API as the single policy and authorization boundary,
allows agent access to be revoked independently, and prevents schema changes from becoming an agent
contract.

## Adjacent credentials and exclusions

- `AUTH_SECRET` and the selected OAuth client secret stay only in the Vercel web trust boundary and
  follow their own session/provider rotation procedure.
- Pluggy Client ID/Secret stay only in provider-consuming Railway backend services and the Pluggy
  authentication boundary. Short-lived Pluggy API keys are cached in memory and never persisted.
- Database credentials stay only in services with repository responsibilities; web and MCP never
  receive them.
- The data-encryption keyring follows ADR 0007's versioned, resumable data-re-encryption workflow.
  Encryption keys must not be rotated with this bearer-token procedure.

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
- Receivers need a tested temporary dual-acceptance mechanism before zero-downtime rotation is
  operationally available.
- Every rotation requires positive availability checks, negative-scope checks, explicit retirement,
  and safe audit evidence.
- MCP incurs an API hop and cannot issue ad hoc SQL, in exchange for stable financial policy,
  bounded results, and a materially smaller data surface.

## Enforcement and verification

- Configuration rejects short or detectably reused credentials and development bypasses in
  production.
- API tests prove each guard's positive route matrix and cross-guard rejection.
- Browser artifact and network tests prove privileged values never reach the client.
- MCP tests prove no database dependency, mutation route, raw data, notes, or unbounded transaction
  surface exists.
- A non-production exercise rotates each boundary independently before production readiness is
  claimed; the secret-rotation runbook captures platform commands, rollback, and evidence.
