# Personal Finance Intelligence Platform

## Required Amendments and Integration Specification

**Status:** Incorporated into implementation plan v1.1 on August 22, 2026\
**Applies to:** `personal-finance-platform-implementation-plan.md`\
**Verified against current Pluggy documentation:** August 22, 2026\
**Primary purpose:** Define every correction that must be incorporated into the main implementation plan before Codex generates the initial production database migrations or builds the provider-ingestion pipeline.

---

## 1. How to Use This Document

This file is retained as the decision and verification record that produced implementation plan v1.1.

1. The amendments below were incorporated into `personal-finance-platform-implementation-plan.md` on August 22, 2026.
2. The updated main plan is now the canonical implementation specification; this file is not a second runtime override.
3. Use §§3 and 26 here as an audit map/checklist when reviewing the integrated plan.
4. Do not generate the first production migration unless the integrated database, authentication, queue, encryption, and provider-behavior requirements remain present.
5. Future design corrections should update the main plan and record the reason rather than reintroducing contradictory companion instructions.

This document remains intentionally detailed so reviewers can trace why the target schemas, state transitions, API behavior, constraints, tests, and backlog changed.

---

## 2. Blocking Corrections Summary

The following changes are mandatory:

1. **Separate provider-owned transaction facts from user-owned state.** The current transaction table cannot safely support notes, review state, effective bill linkage, original/account-currency amounts, or field-level manual overrides.
2. **Normalize credit-card bill payments and finance charges.** Keeping them only in encrypted raw payloads is insufficient for reconciliation.
3. **Replace the single encryption key with a versioned keyring.** New writes must use an active key version while old versions remain available for decryption during rotation.
4. **Use three independent application credentials.** Web-to-API, Hermes-to-MCP, and MCP-to-API access must not share tokens or roles.
5. **Make the PostgreSQL queue lease-based.** Add heartbeats, lease expiration, safe stale-job recovery, and active-job deduplication constraints.
6. **Implement Pluggy lifecycle and edge-case behavior explicitly.** This includes deleted Items, waiting-for-user states, transaction-ID replacement, credit-card sign conventions, and Brazil-local date derivation.
7. **Enforce workspace isolation in the database.** Provider uniqueness, composite foreign keys, category visibility, and repository queries must all be workspace-aware.
8. **Treat Pluggy categorization and merchant enrichment as optional.** The local deterministic classifier must work when provider category and merchant fields are absent.
9. **Track historical coverage.** Pluggy currently describes transaction retrieval as up to 12 months; the application must not imply that older comparisons are complete when the provider returned less history.

These are not cosmetic refinements. They prevent incorrect financial totals, accidental cross-workspace references, lost manual corrections, undecryptable data after key rotation, duplicate jobs, and brittle provider synchronization.

---

## 3. Amendment Map for the Original Plan

| Original plan section | Required amendment |
|---|---|
| §3 Key Assumptions and Constraints | State that provider history is **up to** 12 months, enrichment may be unavailable, and coverage must be measured per account. |
| §4 System Context and Trust Boundaries | Define three separate credentials and resolve MCP architecture in favor of MCP calling the API with a read-only token. |
| §6 Environment Strategy | Replace `DATA_ENCRYPTION_KEY`, `INTERNAL_API_TOKEN`, `FINANCE_API_TOKEN`, and ambiguous MCP token names with the keyring and explicit trust-boundary credentials below. |
| §7 Security and Privacy Model | Add keyring validation, active write-key behavior, associated authenticated data, rotation workflow, and independent credential rotation. |
| §8 Financial and Accounting Policy | Add original/account-currency rules, card sign policy, bill-side versus bank-side payment policy, finance-charge handling, and transaction replacement behavior. |
| §9 PostgreSQL Data Model | Replace the affected transaction design; add user state, bill child tables, replacement links, queue lease fields, history coverage, workspace-scoped constraints, and effective views. |
| §10 Provider Abstraction | Expand provider DTOs for signed amounts, account-currency amounts, bill metadata, Item lifecycle state, bill payments, and finance charges. |
| §11 Ingestion and Synchronization | Add all current Item events, V2 link selection, deletion behavior, transaction replacement handling, history coverage, and missing-enrichment behavior. |
| §12 Merchant Normalization and Classification | Make provider categorization strictly optional and ensure the local classifier has complete null-field tests. |
| §14 Deterministic Analytics | Require the effective transaction view, currency completeness checks, bill reconciliation, and history-coverage warnings. |
| §15 REST API | Add field-level override semantics, notes/review state, bill detail/reconciliation endpoints, amount objects, and history coverage. |
| §16 Web Application | Add explicit transaction review, override provenance, bill reconciliation, user-action-required connection states, and incomplete-history warnings. |
| §17 MCP and Hermes | Require Hermes-to-MCP and MCP-to-API credentials to be distinct; MCP must call the read-only API and never access PostgreSQL directly. |
| §18 Worker and Queue | Add leases, heartbeat rules, atomic claim/reclaim logic, and active dedupe indexes. |
| §21 Local Development | Add fixtures for missing premium fields, Item lifecycle events, transaction replacement, bill child entities, sign variants, and timezone boundaries. |
| §22 Testing | Add the mandatory test matrix in this document. |
| §24 Backlog | Modify existing tickets and add the new tickets listed below. |
| §27 Runbooks | Expand secret rotation into encryption-key rotation and add Item-deletion, user-action, and transaction-replacement runbooks. |
| §28 Risks | Add incomplete provider history, premium-field absence, replacement identity, and bill reconciliation risks. |
| §30 Open Decisions | Resolve the MCP architecture decision: MCP calls the Finance API over Railway private networking with a dedicated read-only credential. |
| §32 Acceptance Checklist | Add the final acceptance checks from this document. |
| §33 References | Add the official Pluggy sources listed at the end of this document. |

---

## 4. Revised Non-Negotiable Architecture Decisions

### 4.1 Provider data and user decisions are separate

Provider synchronization may update only provider-owned and system-derived fields. It must never overwrite:

- user notes;
- review status;
- category override;
- merchant override;
- financial-role override;
- explicit include/exclude-from-spending override;
- user tags;
- a manually confirmed replacement or reconciliation decision.

Do not use one `is_manual_override` boolean. It is too coarse and cannot represent which field is protected or whether a user intentionally cleared a value.

### 4.2 PostgreSQL is the source of truth

Pluggy remains a replaceable data provider. The application stores:

1. encrypted provider evidence;
2. normalized provider facts;
3. deterministic system interpretation;
4. user-owned corrections and review state.

Analytics and MCP responses use the effective application view, not the raw provider category or merchant fields.

### 4.3 MCP must call the API

Resolve the original direct-package-versus-API question as follows for the personal production architecture:

```text
Hermes
  -> public HTTPS MCP endpoint
  -> MCP_CLIENT_TO_MCP_TOKEN
  -> MCP service
  -> Railway private-network Finance API
  -> MCP_TO_API_READONLY_TOKEN
  -> deterministic analytics/repository layer
  -> PostgreSQL
```

The MCP service must not connect directly to PostgreSQL and must not reuse the web application's API credential.

### 4.4 All runtime queries remain workspace-scoped

Even though the first release has one owner and one workspace, every repository method, uniqueness constraint, and workspace-owned foreign key must be designed as if multiple workspaces already exist. This avoids a dangerous commercial migration later.

---

## 5. Environment and Credential Changes

### 5.1 Railway API and worker variables

Replace the relevant original variables with:

```text
NODE_ENV
APP_TIMEZONE=America/Sao_Paulo
DEFAULT_CURRENCY=BRL
DATABASE_URL

PLUGGY_CLIENT_ID
PLUGGY_CLIENT_SECRET
PLUGGY_WEBHOOK_SECRET
PLUGGY_BASE_URL=https://api.pluggy.ai

DATA_ENCRYPTION_ACTIVE_KEY_VERSION
DATA_ENCRYPTION_KEYRING_JSON

WEB_TO_API_TOKEN
MCP_TO_API_READONLY_TOKEN

WEB_APP_URL
API_PUBLIC_URL
API_PRIVATE_URL
LOG_LEVEL
SENTRY_DSN
```

`SENTRY_DSN` remains optional.

### 5.2 Vercel web variables

```text
AUTH_SECRET
AUTH_GITHUB_ID
AUTH_GITHUB_SECRET
ALLOWED_USER_EMAIL
FINANCE_API_BASE_URL
WEB_TO_API_TOKEN
NEXT_PUBLIC_APP_NAME
```

The browser must never receive `WEB_TO_API_TOKEN`. Only Next.js server components, route handlers, and server actions may use it.

### 5.3 MCP variables

```text
MCP_PUBLIC_URL
FINANCE_API_PRIVATE_URL
MCP_CLIENT_TO_MCP_TOKEN
MCP_TO_API_READONLY_TOKEN
MCP_RATE_LIMIT_PER_MINUTE
```

### 5.4 Credential roles

| Credential | Stored by | Caller | Receiver | Allowed capability |
|---|---|---|---|---|
| `WEB_TO_API_TOKEN` | Vercel and API | Next.js server | Finance API | Owner read/write routes only |
| `MCP_CLIENT_TO_MCP_TOKEN` | Hermes host and MCP | Hermes | MCP server | Invoke approved MCP tools only |
| `MCP_TO_API_READONLY_TOKEN` | MCP and API | MCP server | Finance API | Bounded read-only analytics and transaction queries |
| `PLUGGY_WEBHOOK_SECRET` | Pluggy webhook configuration and API | Pluggy | Webhook endpoint | Insert one authenticated webhook event only |
| Pluggy Client ID/Secret | Railway API/worker only | Provider adapter | Pluggy Auth | Obtain short-lived provider API keys |

Rules:

- Each token is independently generated and rotated.
- Tokens must be at least 256 bits of cryptographically random entropy.
- The API maps the presented credential to a fixed role and workspace. The caller cannot request a role through a header or body field.
- Compare static tokens using a constant-time function.
- Never log token values or token prefixes.
- The worker accesses shared repositories/PostgreSQL directly and does not need an API token by default.
- If the worker ever calls the API, introduce a fourth dedicated worker credential rather than reusing another token.

---

## 6. Versioned Encryption Keyring

### 6.1 Required configuration

Replace the single `DATA_ENCRYPTION_KEY` with:

```text
DATA_ENCRYPTION_ACTIVE_KEY_VERSION=2
DATA_ENCRYPTION_KEYRING_JSON={"1":"<base64-32-byte-key>","2":"<base64-32-byte-key>"}
```

The JSON value is illustrative. Production values are entered directly into Railway secrets and are never committed.

Configuration validation must ensure:

- the active version exists in the keyring;
- every version key is a positive integer represented canonically;
- every decoded key is exactly 32 bytes;
- no empty, duplicate, or malformed key exists;
- production startup fails closed when validation fails.

### 6.2 Encryption service contract

Implement a shared service conceptually equivalent to:

```ts
interface EncryptedEnvelope {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
  plaintextSha256: string;
}

interface EncryptionService {
  encrypt(input: Uint8Array, context: EncryptionContext): EncryptedEnvelope;
  decrypt(envelope: EncryptedEnvelope, context: EncryptionContext): Uint8Array;
}
```

New writes always use `DATA_ENCRYPTION_ACTIVE_KEY_VERSION`. Reads select the key using the row's `key_version`.

Use AES-256-GCM with a unique random nonce for every encryption. Bind the ciphertext to stable row context through additional authenticated data. The context should include, at minimum:

```text
workspace_id
storage_table
record_id
provider
entity_type
external_id or event_id
key_version
```

This prevents ciphertext from being copied to a different row or workspace and still decrypting successfully.

### 6.3 Rotation workflow

Add an `encryption_rotation_run` table or an equivalent durable progress record:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `from_key_version` | integer | Required |
| `to_key_version` | integer | Required |
| `status` | text | `PENDING`, `RUNNING`, `PAUSED`, `SUCCEEDED`, `FAILED` |
| `current_table` | text | Progress cursor |
| `last_processed_id` | uuid | Nullable |
| `rows_examined` | bigint | Default 0 |
| `rows_reencrypted` | bigint | Default 0 |
| `started_at` | timestamptz | Nullable |
| `heartbeat_at` | timestamptz | Nullable |
| `finished_at` | timestamptz | Nullable |
| `last_error_summary` | text | Redacted |

Rotation sequence:

1. Generate a new 32-byte key.
2. Add it to the keyring while retaining all old keys.
3. Set the new version as active and deploy.
4. Confirm new records use the new version.
5. Run a resumable batched re-encryption job for `provider_raw_object` and `webhook_event`.
6. Decrypt with the old key, verify the plaintext hash, and encrypt with the active key.
7. Update one bounded batch per transaction.
8. Verify that no relevant row still references the old version.
9. Perform and verify an off-platform backup.
10. Remove the retired key only in a later deployment.

A key must never be deleted merely because it is no longer active.

### 6.4 Required encryption tests

- encrypt/decrypt with the active key;
- decrypt an old-version row after a new key becomes active;
- reject a modified ciphertext, tag, IV, or associated-data context;
- rotate a mixed-version fixture set and resume after interruption;
- prove that new writes use only the active version;
- fail startup when the active key is absent;
- prove that removal of an in-use old key is detected before deployment or by a readiness check.

---

## 7. Workspace Isolation and Database Integrity

### 7.1 Workspace-scoped provider uniqueness

Replace global provider uniqueness with workspace-scoped uniqueness:

```text
provider_connection: (workspace_id, provider, external_connection_id)
financial_account:   (workspace_id, provider, external_account_id)
credit_card_bill:    (workspace_id, provider, external_bill_id)
financial_transaction: (workspace_id, provider, provider_transaction_id)
```

The transaction index remains partial because a provider transaction ID may be temporarily absent:

```sql
CREATE UNIQUE INDEX financial_transaction_provider_id_uq
ON financial_transaction (workspace_id, provider, provider_transaction_id)
WHERE provider_transaction_id IS NOT NULL;
```

### 7.2 Composite workspace foreign keys

Adding `workspace_id` to both tables is not enough. It would still be possible for a row in Workspace A to reference a globally unique ID owned by Workspace B.

For every workspace-owned parent table, add a composite candidate key:

```sql
ALTER TABLE financial_account
ADD CONSTRAINT financial_account_workspace_id_id_uq
UNIQUE (workspace_id, id);
```

Then use composite foreign keys:

```sql
ALTER TABLE financial_transaction
ADD CONSTRAINT financial_transaction_account_workspace_fk
FOREIGN KEY (workspace_id, financial_account_id)
REFERENCES financial_account (workspace_id, id);
```

Apply this pattern to at least:

- provider connection -> financial account;
- financial account -> credit-card bill;
- account/bill -> financial transaction;
- transaction -> transaction user state;
- transaction -> transaction revision;
- bill -> bill payment;
- bill -> bill finance charge;
- bill payment -> reconciliation;
- transaction -> tags;
- merchant -> aliases;
- transaction -> replacement links;
- rules and workspace-owned target entities;
- recurring/installment series and their transactions.

### 7.3 Category uniqueness and visibility

The current plan allows built-in categories with `workspace_id IS NULL` and custom categories with a workspace ID. Keep that model only with database enforcement.

Required indexes:

```sql
CREATE UNIQUE INDEX category_builtin_code_uq
ON category (code)
WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX category_workspace_code_uq
ON category (workspace_id, code)
WHERE workspace_id IS NOT NULL;
```

Custom category codes must not collide with built-in codes. The simplest policy is to generate custom codes as `custom.<uuid>` and treat display names as user-editable.

Add database validation, preferably a trigger function, with these rules:

- a built-in category may have only a built-in parent;
- a workspace category may have a built-in parent or a parent in the same workspace;
- a transaction, merchant, override, budget line, or rule in Workspace A may reference only a built-in category or a category in Workspace A;
- cross-workspace category references fail in PostgreSQL even if application validation is bypassed.

Do not rely exclusively on frontend filtering or repository conventions for category scope.

### 7.4 Repository contract

Every repository method for workspace-owned data must require `workspaceId` as a non-optional argument. Prohibit unscoped methods such as:

```ts
getTransactionById(id)
```

Require:

```ts
getTransactionById(workspaceId, id)
```

The same applies to updates, deletes, bill lookups, merchant merges, rules, jobs, and analytics queries.

---

## 8. Provider, Webhook, and Queue Schema Amendments

### 8.1 `provider_connection`

Expand the local status model:

```text
ACTIVE
SYNCING
USER_INPUT_REQUIRED
USER_ACTION_REQUIRED
REAUTH_REQUIRED
PROVIDER_ERROR
DELETED
DISABLED
```

Add or retain these fields:

| Column | Type | Notes |
|---|---|---|
| `workspace_id` | uuid | Required |
| `provider` | text | `PLUGGY` initially |
| `external_connection_id` | text | Pluggy Item ID |
| `local_status` | text | One of the states above |
| `provider_item_status` | text | Latest raw Item status, nullable |
| `provider_execution_status` | text | Latest raw execution status, nullable |
| `action_required_at` | timestamptz | Nullable |
| `last_attempt_at` | timestamptz | Nullable |
| `last_successful_sync_at` | timestamptz | Nullable |
| `last_provider_update_at` | timestamptz | Nullable |
| `last_error_code` | text | Redacted/bounded |
| `last_error_summary` | text | Redacted/bounded |
| `deleted_at` | timestamptz | Nullable |

Do not store raw `providerMessage` in plaintext. Keep full provider evidence encrypted in the raw object table; store only a safe owner-facing summary in the connection row.

### 8.2 `webhook_event`

Add `workspace_id`. It may be nullable only when the incoming Item cannot be mapped to a known local connection.

Add status `UNMAPPED` and record a safe alert when that occurs.

Use a uniqueness expression that handles system/unmapped events:

```sql
CREATE UNIQUE INDEX webhook_event_dedupe_uq
ON webhook_event (
  COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
  provider,
  external_event_id
);
```

The webhook route must perform only:

1. secret verification;
2. bounded JSON parsing and validation;
3. local workspace lookup by `itemId` when present;
4. encrypted inbox insert;
5. deduplicated job insert;
6. immediate `202` response.

No provider API call may occur before the response.

### 8.3 `job_queue`

Add:

| Column | Type | Notes |
|---|---|---|
| `started_at` | timestamptz | First successful claim time |
| `heartbeat_at` | timestamptz | Last worker heartbeat |
| `lease_expires_at` | timestamptz | Reclaim boundary |
| `finished_at` | timestamptz | Terminal completion time |

`locked_at` may remain for diagnostics, but stale recovery must be based on the lease, not only on `locked_at`.

Required active dedupe index:

```sql
CREATE UNIQUE INDEX job_queue_active_dedupe_uq
ON job_queue (
  COALESCE(workspace_id, '00000000-0000-0000-0000-000000000000'::uuid),
  job_type,
  dedupe_key
)
WHERE dedupe_key IS NOT NULL
  AND status IN ('PENDING', 'RETRY', 'RUNNING');
```

Examples:

```text
process-webhook:<provider-event-id>
sync-connection:<internal-connection-id>
sync-account:<internal-account-id>
classify-transaction:<transaction-id>:<input-fingerprint>
rebuild-installments:<workspace-id>
rotate-key:<rotation-run-id>
```

### 8.4 Queue claim and lease behavior

Claim jobs atomically with `FOR UPDATE SKIP LOCKED` and an `UPDATE ... RETURNING` in the same transaction.

Recommended defaults:

```text
lease duration: 120 seconds
heartbeat interval: 30 seconds
maximum heartbeat interval: no more than one-third of lease duration
```

Worker rules:

- set `started_at` only on the first claim;
- set `heartbeat_at` and `lease_expires_at` on claim;
- extend the lease while long work is active;
- stop claiming new work on SIGTERM;
- complete the active unit or let its lease expire safely;
- reclaim only `RUNNING` jobs whose `lease_expires_at < now()`;
- increment attempts and apply bounded backoff when reclaiming;
- never let two active jobs with the same dedupe key exist;
- mark terminal jobs with `finished_at`.

A worker must not mark a job successful after it has lost its lease. Completion should include a compare-and-update condition on `locked_by`, status, and unexpired lease.

---

## 9. Financial Account and History Coverage Changes

Add the following to `financial_account`:

| Column | Type | Notes |
|---|---|---|
| `provider_history_earliest_date` | date | Earliest provider transaction observed |
| `provider_history_latest_date` | date | Latest provider transaction observed |
| `initial_import_completed_at` | timestamptz | Nullable |
| `history_coverage_status` | text | See values below |
| `history_coverage_note` | text | Bounded, non-sensitive |

Suggested statuses:

```text
UNKNOWN
PARTIAL
PROVIDER_MAXIMUM_RETRIEVED
USER_EXTENDED_HISTORY
```

Rules:

- “Up to 12 months” is a provider maximum, not a guarantee.
- Do not mark `PROVIDER_MAXIMUM_RETRIEVED` merely because 12 calendar months were requested. Use observed dates and provider behavior.
- If the institution returns fewer months, mark `PARTIAL` and display the actual earliest available date.
- If a later CSV/manual import adds older history, use `USER_EXTENDED_HISTORY` or add a future source-coverage table.
- Analytics must emit an incomplete-history warning whenever the requested comparison predates known coverage.
- MCP must repeat that warning rather than presenting a partial comparison as complete.

---

## 10. Credit-Card Bill Normalization and Reconciliation

### 10.1 `credit_card_bill`

Add:

| Column | Type | Notes |
|---|---|---|
| `allows_installments` | boolean | Nullable provider value |
| `provider_status` | text | Raw normalized provider status |
| `reconciliation_status` | text | Optional cached status; source of truth may be a view |

Retain workspace-scoped uniqueness:

```text
(workspace_id, provider, external_bill_id)
```

### 10.2 `credit_card_bill_payment`

Create a normalized child table:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `workspace_id` | uuid | Required |
| `credit_card_bill_id` | uuid | Composite workspace FK |
| `provider` | text | `PLUGGY` initially |
| `external_payment_id` | text | Provider payment ID |
| `value_type` | text | Example `FULL_PAYMENT` |
| `payment_date` | date | Provider payment date converted consistently |
| `payment_mode` | text | Example `PIX`, nullable |
| `amount` | numeric(20,6) | Non-negative magnitude |
| `currency` | char(3) | Required |
| `matched_card_transaction_id` | uuid | Nullable composite workspace FK |
| `latest_raw_object_id` | uuid | Nullable |
| timestamps | timestamptz | Standard |

Unique constraint:

```text
(workspace_id, credit_card_bill_id, provider, external_payment_id)
```

### 10.3 `credit_card_bill_finance_charge`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `workspace_id` | uuid | Required |
| `credit_card_bill_id` | uuid | Composite workspace FK |
| `provider` | text | `PLUGGY` initially |
| `external_charge_id` | text | Provider charge ID |
| `charge_type` | text | `IOF`, late fee, interest, `OTHER`, etc. |
| `amount` | numeric(20,6) | Non-negative magnitude |
| `currency` | char(3) | Required |
| `additional_info` | text | Nullable and bounded |
| `matched_transaction_id` | uuid | Nullable composite workspace FK |
| `latest_raw_object_id` | uuid | Nullable |
| timestamps | timestamptz | Standard |

### 10.4 `bill_payment_reconciliation`

Connect the bill-side payment object to the corresponding bank-account cash movement:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `workspace_id` | uuid | Required |
| `credit_card_bill_payment_id` | uuid | Composite workspace FK |
| `financial_transaction_id` | uuid | Expected checking-account transaction |
| `match_status` | text | See values below |
| `match_method` | text | `AMOUNT_DATE`, `REFERENCE`, `USER`, etc. |
| `confidence` | numeric(5,4) | Nullable |
| `matched_at` | timestamptz | Nullable |
| `confirmed_by` | text | Nullable actor ID |
| timestamps | timestamptz | Standard |

Statuses:

```text
UNMATCHED
CANDIDATE
AUTO_MATCHED
USER_CONFIRMED
REJECTED
```

Enforce at most one active confirmed match per bill payment with a partial unique index covering `AUTO_MATCHED` and `USER_CONFIRMED`.

### 10.5 Bill accounting rules

- Bill payment objects and finance-charge objects are normalized reconciliation evidence, not automatically independent spending facts.
- Spending totals normally come from financial transaction rows.
- A checking-account payment of the credit-card bill affects cash flow but is excluded from spending.
- A card-side negative payment entry is also excluded from spending and cash flow when the matching checking-account payment already represents the cash movement.
- Refunds and credits must not be classified as bill payments solely because a card amount is negative.
- Finance charges count as spending when represented by a card transaction. If the bill object reports a charge with no matching transaction, mark the bill as unreconciled rather than silently inventing a transaction in the first release.
- Use a configurable currency tolerance for reconciliation, for example BRL 0.01.
- Keep unmatched and ambiguous records visible for review.

Create a view such as `v_credit_card_bill_reconciliation` that exposes:

- bill total;
- bill-linked transaction total;
- normalized finance charges;
- normalized payments;
- confirmed bank payment total;
- difference/tolerance;
- reconciliation status;
- unresolved items.

---

## 11. Revised Transaction Model

### 11.1 Replace the current transaction schema before migration

The original `financial_transaction` table combines provider facts, derived classifications, and user-owned fields. Replace it with the model below.

### 11.2 `financial_transaction`: provider and system facts

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `workspace_id` | uuid | Required |
| `financial_account_id` | uuid | Composite workspace FK |
| `provider` | text | `PLUGGY` initially |
| `provider_transaction_id` | text | Pluggy transaction ID, nullable only when unavoidable |
| `provider_id` | text | Bank/Open Finance provider identifier, nullable |
| `provider_code` | text | Nullable |
| `status` | text | `PENDING`, `POSTED`, `DELETED`, `UNKNOWN` |
| `provider_type` | text | Provider `DEBIT`/`CREDIT`, nullable |
| `provider_operation_type` | text | Nullable |
| `provider_operation_type_additional_info` | text | Nullable and bounded |
| `provider_amount_signed` | numeric(20,6) | Exact signed amount from provider |
| `provider_currency` | char(3) | Transaction currency |
| `account_currency_amount_signed` | numeric(20,6) | Nullable `amountInAccountCurrency` |
| `account_currency` | char(3) | Account currency at observation time |
| `system_direction` | text | `INFLOW`, `OUTFLOW`, `NEUTRAL`, `UNKNOWN` |
| `system_financial_role` | text | Deterministic policy role |
| `system_is_excluded_from_spend` | boolean | Deterministic default |
| `provider_transaction_at` | timestamptz | Exact parsed provider date/time |
| `transaction_local_date` | date | Derived using workspace IANA timezone |
| `provider_purchase_at` | timestamptz | Nullable installment purchase date |
| `purchase_local_date` | date | Nullable |
| `description_original` | text | Provider description |
| `description_raw` | text | Nullable raw description |
| `description_normalized` | text | Local normalization |
| `provider_category_id` | text | Nullable |
| `provider_category_name` | text | Nullable |
| `system_merchant_id` | uuid | Nullable composite workspace FK |
| `system_category_id` | uuid | Nullable, category visibility enforced |
| `classification_source` | text | `RULE`, `MERCHANT`, `HEURISTIC`, `PROVIDER`, `MODEL`, `NONE` |
| `classification_confidence` | numeric(5,4) | Nullable |
| `installment_number` | integer | Nullable |
| `installment_total` | integer | Nullable |
| `installment_total_amount` | numeric(20,6) | Nullable |
| `payee_mcc` | text | Nullable |
| `card_last_four` | text | Nullable |
| `provider_bill_id` | text | Nullable external bill reference |
| `credit_card_bill_id` | uuid | Nullable composite workspace FK |
| `bill_forecast_month` | date | Nullable; first day of forecast month |
| `fee_type` | text | Nullable |
| `fee_type_additional_info` | text | Nullable and bounded |
| `other_credits_type` | text | Nullable |
| `other_credits_additional_info` | text | Nullable and bounded |
| `installment_series_id` | uuid | Nullable composite workspace FK |
| `recurring_series_id` | uuid | Nullable composite workspace FK |
| `transfer_pair_id` | uuid | Nullable composite workspace self-FK |
| `duplicate_review_status` | text | Existing duplicate workflow |
| `dedupe_fingerprint` | char(64) | Indexed review aid |
| `latest_raw_object_id` | uuid | Nullable |
| timestamps | timestamptz | Standard |
| `deleted_at` | timestamptz | Nullable |

Important rules:

- Preserve `provider_amount_signed` exactly. Never overwrite it with a normalized magnitude.
- `account_currency_amount_signed` is nullable and must not be fabricated.
- Do not use JavaScript floating-point numbers for money calculations.
- `system_*` values may be recalculated by the deterministic policy engine.
- Provider synchronization may update only provider-owned and system-derived fields.
- The partial workspace-scoped provider-ID unique index is mandatory.

### 11.3 `transaction_user_state`: notes, review, and field-level overrides

Create one optional one-to-one state row per financial transaction:

| Column | Type | Notes |
|---|---|---|
| `financial_transaction_id` | uuid | Primary key and composite workspace FK |
| `workspace_id` | uuid | Required |
| `category_override_enabled` | boolean | Default false |
| `category_id_override` | uuid | Nullable; null with enabled=true means explicitly unclassified |
| `merchant_override_enabled` | boolean | Default false |
| `merchant_id_override` | uuid | Nullable; null with enabled=true means explicitly no merchant |
| `financial_role_override_enabled` | boolean | Default false |
| `financial_role_override` | text | Nullable |
| `excluded_from_spend_override` | boolean | Nullable; null means inherit system value |
| `notes` | text | Nullable, bounded |
| `review_status` | text | `UNREVIEWED`, `NEEDS_REVIEW`, `CONFIRMED`, `IGNORED` |
| `version` | integer | Optimistic concurrency, default 1 |
| `updated_by_actor_type` | text | `USER`, `SYSTEM`, `MIGRATION` |
| `updated_by_actor_id` | text | Nullable |
| timestamps | timestamptz | Standard |

Why explicit override-enabled flags are required:

- `category_id_override = NULL` could mean either “inherit system category” or “the user deliberately cleared the category.”
- The boolean flag distinguishes those states.
- Provider sync never writes this table.

### 11.4 Effective transaction view

Create `v_financial_transaction_effective` as the canonical query source for the UI, analytics, and MCP.

Conceptually:

```text
effective_category_id =
  if category_override_enabled then category_id_override
  else system_category_id

effective_merchant_id =
  if merchant_override_enabled then merchant_id_override
  else system_merchant_id

effective_financial_role =
  if financial_role_override_enabled then financial_role_override
  else system_financial_role

effective_is_excluded_from_spend =
  coalesce(excluded_from_spend_override, system_is_excluded_from_spend)
```

The view also exposes override provenance so the UI can show whether a value came from the user, a rule, a merchant mapping, the provider, or remains unresolved.

All existing spend, cash-flow, category, merchant, recurring, installment, anomaly, forecast, and MCP queries must read from this effective view or a derived view built on it.

### 11.5 Currency representation

Expose and preserve two monetary representations:

1. **Original transaction amount** — `provider_amount_signed` and `provider_currency`.
2. **Account-currency amount** — `account_currency_amount_signed` and `account_currency`, when supplied by the provider.

Analytics in the account/workspace base currency use:

```text
account_currency_amount_signed when present;
otherwise provider_amount_signed only when provider_currency == account_currency;
otherwise mark the row as not convertible without an exchange-rate source.
```

Do not silently add BRL and USD values. Mixed-currency responses must either:

- group totals by currency; or
- omit non-convertible rows from a base-currency total and return an explicit warning/count.

### 11.6 API amount shape

Transaction responses should use decimal strings:

```json
{
  "amounts": {
    "original": {
      "signed": "125.40",
      "magnitude": "125.40",
      "currency": "USD"
    },
    "accountCurrency": {
      "signed": "708.14",
      "magnitude": "708.14",
      "currency": "BRL"
    }
  }
}
```

`accountCurrency` may be null.

---

## 12. Transaction Replacement and Logical Continuity

Pluggy documents that substantial changes to date, description, or amount can cause an existing transaction to be deleted and a new transaction to be created with a different ID. The local system must preserve audit evidence and, when safe, user decisions.

### 12.1 `transaction_identity_link`

Create:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | Primary key |
| `workspace_id` | uuid | Required |
| `predecessor_transaction_id` | uuid | Composite workspace FK |
| `successor_transaction_id` | uuid | Composite workspace FK |
| `link_type` | text | `PROVIDER_REPLACEMENT` initially |
| `status` | text | `AUTO_CONFIRMED`, `NEEDS_REVIEW`, `USER_CONFIRMED`, `REJECTED` |
| `confidence` | numeric(5,4) | Nullable |
| `evidence` | jsonb | Bounded, non-sensitive comparison features |
| `detected_at` | timestamptz | Required |
| `confirmed_at` | timestamptz | Nullable |
| `confirmed_by` | text | Nullable |

Reject self-links and cross-workspace links. Prevent more than one active confirmed successor for a predecessor.

### 12.2 Candidate matching

Evaluate a replacement candidate only when:

- an old transaction was deleted during the same sync window;
- a new transaction appeared in the same account;
- currency and amount are compatible;
- local dates are within a small configurable window;
- normalized description similarity is sufficiently high;
- installment metadata, bill period, card suffix, and MCC do not conflict.

Do not use the existing dedupe fingerprint as automatic proof of identity.

Suggested behavior:

- auto-confirm only above a high threshold, for example `>= 0.95`, with no competing candidate;
- otherwise create `NEEDS_REVIEW`;
- preserve both provider records permanently;
- never silently merge or delete audit history.

### 12.3 Transfer of user state

For an auto-confirmed or user-confirmed replacement:

1. Copy user state to the successor only when the successor has no conflicting user state.
2. Copy transaction tags.
3. Preserve the predecessor state and mark the migration in audit/revision records.
4. Record exactly which fields were transferred.
5. Do not copy duplicate-review or provider status fields.
6. If either side has conflicting manual values, stop and require review.

Add regression tests proving that notes, category overrides, merchant overrides, financial-role overrides, exclusion overrides, review state, and tags survive a confirmed provider-ID replacement.

---

## 13. Pluggy Amount Sign and Financial-Role Policy

### 13.1 Never normalize by sign alone

Store the provider amount and provider type exactly. Determine local direction and financial role using:

```text
account type
provider amount sign
provider type
operation type
fee metadata
other-credit metadata
bill linkage
bill payment reconciliation
merchant/description evidence
```

### 13.2 Credit-card convention

Current Pluggy documentation states:

- positive credit-card amounts represent new charges that increase the outstanding balance;
- negative credit-card amounts represent credits or payments that reduce the outstanding balance.

Local interpretation:

| Evidence | Default role | Spend effect | Cash-flow effect |
|---|---|---:|---:|
| Positive card purchase | `PURCHASE` | Positive expense | 0 until bank payment |
| Positive card fee with `feeType` | `FEE` | Positive expense | 0 until bank payment |
| Negative card transaction matched to a purchase/refund | `REFUND` or `CREDIT` | Reduces expense | 0 |
| Negative card transaction confirmed as bill payment | `CARD_BILL_PAYMENT` | 0 | 0 on card side |
| Checking-account transaction confirmed as card payment | `CARD_BILL_PAYMENT` | 0 | Negative cash flow |
| Unresolved negative card transaction | `UNKNOWN_CREDIT` | No final classification until reviewed | 0 by default |

A negative card amount is not automatically a bill payment.

### 13.3 Finance charges

- Use `feeType`, bill finance-charge rows, descriptions, and bill linkage.
- Include a confirmed fee/interest transaction in spending.
- Do not count the normalized bill charge again if it matches a transaction.
- If only bill metadata exists, expose an unreconciled bill component; do not create synthetic spending silently in the personal MVP.

### 13.4 Bill-payment double-counting prevention

A bill payment may appear in several places:

- the bill's `payments[]` collection;
- a negative card-side transaction;
- a checking-account debit.

The application must represent these as linked evidence for one economic event. Spending excludes all bill-payment representations. Cash flow includes only the actual bank-account outflow.

---

## 14. Date and Time Policy

### 14.1 Store provider timestamp and local financial date

Pluggy transaction dates are delivered as UTC timestamps. Store both:

```text
provider_transaction_at timestamptz
transaction_local_date date
```

Convert using the workspace's IANA timezone, initially:

```text
America/Sao_Paulo
```

Do not spread a hard-coded `UTC-3` offset through the codebase. Use a timezone library and the workspace setting.

Apply the same policy to purchase dates, bill dates, and provider payment dates where a timestamp is available.

### 14.2 Required timezone tests

Include fixtures at:

- `00:00:00Z`;
- immediately before and after local midnight;
- end of month;
- end of year;
- leap day;
- timestamps with explicit offsets;
- a workspace timezone other than São Paulo to prove the helper is not hard-coded.

The original provider timestamp remains immutable even if local-date derivation logic is corrected later.

---

## 15. Optional Categorization and Merchant Enrichment

### 15.1 Provider fields are hints, not dependencies

Pluggy categorization may be disabled after trial and the category fields may be null. Merchant enrichment may also require a paid feature and may return null even when enabled.

The ingestion and application pipeline must succeed with:

```json
{
  "category": null,
  "categoryId": null,
  "merchant": null
}
```

### 15.2 Required classification order

Retain and strengthen the local deterministic order:

```text
1. explicit user field override
2. active user classification rule
3. confirmed local merchant default/alias
4. deterministic local heuristic
5. provider category or merchant hint, when present
6. optional LLM suggestion
7. unclassified/review queue
```

Provider categorization must never override a user correction or a higher-priority local rule.

### 15.3 Missing-field acceptance criterion

The following must work when all premium fields are absent:

- initial import;
- repeated sync;
- transaction list/detail;
- merchant normalization;
- local rule classification;
- manual correction;
- spending and cash-flow analytics;
- unclassified queue;
- bill reconciliation;
- MCP spending and transaction tools.

---

## 16. Pluggy Item and Webhook Lifecycle Behavior

### 16.1 Supported first-wave events

Expand the original event list to include:

```text
item/created
item/updated
item/deleted
item/error
item/waiting_user_input
item/waiting_user_action
item/login_succeeded
transactions/created
transactions/updated
transactions/deleted
```

`connector/status_updated` may be added later for provider-wide health alerts but is not required for the first personal release.

### 16.2 Event-to-state mapping

| Event/provider condition | Local action |
|---|---|
| `item/created` or successful `item/updated` | Fetch current Item; set `SYNCING` while processing; set `ACTIVE` only after required data is collected successfully. |
| `item/login_succeeded` | Set `SYNCING`; do not mark the connection successful because product collection is still in progress. |
| `item/waiting_user_input` | Set `USER_INPUT_REQUIRED`; create owner-visible action alert. |
| `item/waiting_user_action` | Set `USER_ACTION_REQUIRED`; create owner-visible action alert. |
| `item/error` with revoked/not-granted authorization | Set `REAUTH_REQUIRED`. |
| `item/error` with input timeout or account action | Map to the relevant user-action state. |
| transient provider/institution error | Set `PROVIDER_ERROR`; retain last successful data and freshness timestamp. |
| `item/deleted` | Set `DELETED`, record `deleted_at`, stop future sync jobs, preserve all local historical data. |

For Item notifications, fetch the latest Item after the webhook has been acknowledged. For `item/deleted`, a provider `404` is expected and confirms deletion; use the local connection mapping and event as evidence.

### 16.3 Transaction webhook V2 behavior

Use `GET /v2/transactions` exclusively.

For `transactions/created`:

1. Prefer `createdTransactionsLinkV2` when present.
2. Otherwise use `createdTransactionsLink` only when it points to `/v2/transactions`.
3. For older application payloads containing only a page-based link, construct an equivalent V2 request from `accountId` and `transactionsCreatedAtFrom` rather than calling the deprecated endpoint.
4. Validate the host and path before following any provider-supplied link.
5. Continue cursor pagination until `next` is absent.

For `transactions/updated`, retrieve full current objects by IDs in supported batches.

For `transactions/deleted`, soft-delete the referenced local provider records, then run replacement-candidate detection against newly created records from the same sync window.

### 16.4 Provider object deletion

When an Item is deleted:

- disable scheduled and manual provider refreshes for that connection;
- do not delete normalized accounts, bills, transactions, rules, notes, or analytics history;
- mark provider objects as unavailable/stale;
- show the owner that reconnection is required for future data;
- preserve encrypted local snapshots according to the configured retention policy;
- add a runbook for reconnecting and deciding whether the new Item is a continuation of the deleted connection.

---

## 17. Provider Abstraction Changes

Expand provider-neutral DTOs. Pluggy-specific field names are mapped in `provider-pluggy`; they must not leak into domain code.

### 17.1 Transaction DTO

```ts
interface ProviderTransactionDto {
  externalTransactionId: string | null;
  providerId: string | null;
  providerCode: string | null;
  externalAccountId: string;
  status: 'PENDING' | 'POSTED' | 'UNKNOWN';
  providerType: 'DEBIT' | 'CREDIT' | null;
  amountSigned: DecimalString;
  currency: CurrencyCode;
  amountInAccountCurrencySigned: DecimalString | null;
  accountCurrency: CurrencyCode;
  transactionAt: string;
  purchaseAt: string | null;
  description: string;
  descriptionRaw: string | null;
  operationType: string | null;
  operationTypeAdditionalInfo: string | null;
  categoryId: string | null;
  categoryName: string | null;
  merchant: ProviderMerchantDto | null;
  creditCardMetadata: ProviderCreditCardMetadataDto | null;
  raw: unknown;
}
```

### 17.2 Credit-card metadata DTO

Include:

```text
installmentNumber
totalInstallments
totalAmount
payeeMcc
cardLastFour
externalBillId
billForecastMonth
feeType
feeTypeAdditionalInfo
otherCreditsType
otherCreditsAdditionalInfo
```

### 17.3 Bill DTO

```ts
interface ProviderBillDto {
  externalBillId: string;
  externalAccountId: string;
  dueAt: string | null;
  closesAt: string | null;
  totalAmount: DecimalString | null;
  currency: CurrencyCode;
  minimumPaymentAmount: DecimalString | null;
  allowsInstallments: boolean | null;
  payments: ProviderBillPaymentDto[];
  financeCharges: ProviderBillFinanceChargeDto[];
  raw: unknown;
}
```

### 17.4 Connection DTO

Include provider Item status, execution status, error code, last provider update, and any safe flags required to map to the local connection state. Do not pass raw provider messages into the public API.

---

## 18. REST API Amendments

### 18.1 Authentication guards

Create independent guards:

```text
requireWebOwnerCredential
requireMcpReadOnlyCredential
requirePluggyWebhookCredential
```

Do not implement one generic token that receives a caller-supplied role.

### 18.2 Transaction detail response

A transaction detail must include:

- provider status and dates;
- original and account-currency amounts;
- effective category, merchant, financial role, and spend exclusion;
- the source/provenance of each effective field;
- field override states;
- notes and review status for web-owner responses;
- internal bill linkage and bill forecast month;
- installment metadata;
- replacement predecessor/successor information when applicable;
- freshness and history-coverage warning.

MCP responses should omit owner notes by default unless a specific future tool is designed and approved for them.

### 18.3 Transaction patch semantics

Use explicit override operations rather than ambiguous nullable fields:

```json
{
  "expectedVersion": 4,
  "categoryOverride": {
    "mode": "SET",
    "categoryId": "uuid"
  },
  "merchantOverride": {
    "mode": "INHERIT"
  },
  "financialRoleOverride": {
    "mode": "SET",
    "value": "PURCHASE"
  },
  "excludedFromSpendOverride": {
    "mode": "SET",
    "value": false
  },
  "notes": "Personal note",
  "reviewStatus": "CONFIRMED"
}
```

Supported modes:

```text
INHERIT  -> disable the override and use the system value
SET      -> enable and set the supplied value
CLEAR    -> enable and deliberately set category/merchant to null
```

Use optimistic concurrency through `expectedVersion`. Return `409 Conflict` when the user edits a stale state version.

### 18.4 Bill and reconciliation endpoints

Add:

```text
GET  /v1/card-bills/:id
GET  /v1/card-bills/:id/reconciliation
GET  /v1/card-bills/:id/payments
GET  /v1/card-bills/:id/finance-charges
POST /v1/bill-payments/:id/reconciliation-candidates
POST /v1/bill-payments/:id/confirm-reconciliation
POST /v1/bill-payments/:id/reject-reconciliation
```

Only the web-owner role may confirm or reject reconciliation. MCP may read summarized reconciliation state but cannot mutate it.

### 18.5 Review endpoints

Add or formalize:

```text
GET /v1/review/transactions
GET /v1/review/replacements
GET /v1/review/bill-payments
GET /v1/review/unclassified
```

### 18.6 History and currency warnings

Every analytics response must include structured warnings, for example:

```json
{
  "warnings": [
    {
      "code": "INCOMPLETE_HISTORY",
      "message": "Data for this account begins on 2025-10-14; the requested comparison starts earlier."
    },
    {
      "code": "UNCONVERTED_CURRENCY",
      "transactionCount": 2,
      "currencies": ["USD"]
    }
  ]
}
```

---

## 19. Analytics, UI, and MCP Amendments

### 19.1 Analytics views

Add or revise:

```text
v_financial_transaction_effective
v_transaction_spend_effect
v_transaction_cashflow_effect
v_credit_card_bill_reconciliation
v_account_history_coverage
v_transactions_needing_review
v_transaction_replacement_review
```

All downstream analytics use the effective view.

### 19.2 Web application changes

The web plan must include:

- a visible connection state for user input/action, reauthorization, provider error, deletion, and stale data;
- transaction badges for provider/system/user value provenance;
- a notes field and review status;
- explicit “use automatic value,” “set manual value,” and “clear value” controls;
- original-currency and account-currency display;
- bill-linked transaction details;
- bill payment/finance-charge reconciliation page;
- transaction replacement review queue;
- incomplete-history warnings on long-range comparisons;
- missing-provider-enrichment behavior that does not look like a system error.

### 19.3 MCP restrictions

The MCP server:

- authenticates Hermes with `MCP_CLIENT_TO_MCP_TOKEN`;
- calls the Finance API with `MCP_TO_API_READONLY_TOKEN`;
- never connects directly to PostgreSQL;
- never uses `WEB_TO_API_TOKEN`;
- reads effective values only;
- never returns raw provider IDs, encrypted payloads, secret fields, or unrestricted notes;
- propagates freshness, incomplete-history, and currency warnings;
- cannot confirm reconciliation, approve replacements, edit categories, or alter review status.

Add a tool or enhance the card-bill summary tool to report:

```text
bill total
payment status
confirmed bank payment
finance charges
reconciliation difference
unresolved reconciliation count
```

---

## 20. Required Provider Fixtures

Add sanitized fixtures for all of the following:

### 20.1 Transaction and currency fixtures

- checking-account debit and credit;
- positive credit-card purchase;
- negative card refund;
- negative card bill payment;
- negative card credit with ambiguous role;
- foreign-currency purchase with `amountInAccountCurrency`;
- foreign-currency purchase without account-currency amount;
- provider type/sign disagreement requiring safe fallback;
- missing optional operation fields;
- date immediately around Brazil-local midnight.

### 20.2 Bill fixtures

- open bill;
- closed bill;
- bill with full payment;
- bill with partial payments;
- bill with multiple payments;
- bill with IOF and interest charges;
- bill payment that matches one checking transaction;
- bill payment with multiple candidate checking transactions;
- bill payment with no bank-side match;
- charge present in bill metadata and transaction list;
- charge present only in bill metadata.

### 20.3 Provider lifecycle fixtures

- `item/deleted`;
- `item/waiting_user_input`;
- `item/waiting_user_action`;
- `item/login_succeeded`;
- authorization revoked;
- partial success where transactions failed;
- transient institution error;
- duplicate webhook delivery;
- unknown/unmapped Item event.

### 20.4 Replacement fixtures

- pending transaction deleted and posted replacement created with a new ID;
- changed description but same logical transaction;
- changed date and amount that should not auto-link;
- two competing replacement candidates;
- replacement with user notes, tags, and overrides;
- rejected replacement candidate.

### 20.5 Enrichment and coverage fixtures

- category and merchant both populated;
- category null;
- merchant null;
- both null;
- fewer than 12 months returned;
- exactly 12 months returned;
- coverage extended by imported historical data.

No fixture may contain a real production payload or merely pseudonymized real financial data.

---

## 21. Mandatory Test Matrix

### 21.1 Database integrity

- workspace-scoped provider IDs can repeat in different workspaces but not within one workspace;
- cross-workspace account, bill, transaction, merchant, category, tag, replacement, and reconciliation references fail;
- built-in category visibility works;
- custom category cross-workspace references fail;
- effective view returns system values when no override exists;
- effective view returns explicit null when a category/merchant override is enabled and cleared;
- user state survives provider upsert;
- bill child rows upsert idempotently;
- active job dedupe index blocks overlapping work;
- completed jobs do not block a later job with the same dedupe key.

### 21.2 Queue concurrency

- two workers cannot claim the same job;
- heartbeat extends the lease;
- an expired lease is reclaimed once;
- a healthy long-running job is not reclaimed;
- a worker that lost the lease cannot mark the job successful;
- SIGTERM stops new claims and does not corrupt job state;
- webhook retries produce one effective processing job.

### 21.3 Encryption

Use all tests listed in §6.4, including mixed-version rotation and associated-data mismatch.

### 21.4 Provider mapping

- API key cache honors the documented two-hour expiry and refresh margin;
- V2 cursor pagination follows `next` correctly;
- deprecated page endpoint is never called;
- premium category/merchant fields may be null;
- bill payments and finance charges map into child DTOs/tables;
- card sign convention is preserved;
- original UTC timestamp and local date are both correct;
- unknown provider fields do not break ingestion.

### 21.5 Lifecycle and webhook behavior

- webhook returns a successful response in under five seconds without provider calls;
- duplicate event ID is successful and idempotent;
- deleted Item disables future sync and retains local history;
- waiting-user events create the correct connection state;
- login success does not prematurely mark synchronization complete;
- Item errors map to reauthorization, user action, or provider error correctly;
- old and new `transactions/created` link shapes result in V2 requests only.

### 21.6 Financial correctness

- card purchases count in spending but not immediate bank cash flow;
- confirmed checking-account bill payment counts in cash flow but not spending;
- card-side payment does not double-count cash flow;
- refunds reduce spending;
- ambiguous negative card transactions remain unresolved;
- finance charges are counted once;
- bill totals and payment reconciliation respect currency/tolerance;
- mixed currencies are not silently combined;
- pending/posted transitions do not duplicate spending;
- confirmed replacement preserves one logical spending event and user state.

### 21.7 API and authorization

- web token can use owner routes but not webhook or MCP authentication;
- MCP client token authenticates only the MCP endpoint;
- MCP-to-API token can access only approved read routes;
- no credential can be substituted for another;
- browser artifacts and network calls never contain `WEB_TO_API_TOKEN`;
- transaction patch modes `SET`, `CLEAR`, and `INHERIT` work;
- optimistic concurrency returns `409` on stale user-state version;
- MCP responses omit notes and internal identifiers;
- history and currency warnings propagate through API and MCP.

---

## 22. Backlog Amendments

### 22.1 Modify existing tickets

#### PF-002 — Environment validation

Add:

- keyring parsing and active-key validation;
- independent credential validation;
- prevention of credential reuse where detectable;
- tests for malformed keyring and missing active key.

#### PF-013 — Provider/sync schema

Add:

- expanded connection states;
- `workspace_id` on webhook events;
- queue lease/heartbeat fields;
- active dedupe index;
- workspace-scoped provider uniqueness.

#### PF-014 — Financial core schema

Replace the original transaction portion with:

- revised provider/system transaction table;
- transaction user state;
- transaction identity link;
- bill payments;
- bill finance charges;
- bill payment reconciliation;
- account history coverage;
- composite workspace FKs.

#### PF-016 — Initial views and indexes

Add all effective, bill reconciliation, history coverage, and replacement review views/indexes.

#### PF-020 — Money and date types

Add:

- signed original and account-currency amount types;
- strict decimal string serialization;
- IANA timezone conversion helpers;
- month-only bill forecast representation.

#### PF-021 — Transaction policy

Add:

- account-type-aware sign matrix;
- bill-side/card-side/bank-side payment rules;
- finance-charge deduplication;
- unresolved card credit behavior;
- mixed-currency policy.

#### PF-022 — Provider-neutral contracts

Add the revised DTOs from §17.

#### PF-024 — Pluggy data client

Add:

- bill child mapping;
- Item state mapping inputs;
- V2 webhook link normalization;
- provider date/account-currency fields.

#### PF-025 — Pluggy fixture contract tests

Require all fixtures from §20.

#### PF-030 — Encryption service

Replace single-key behavior with the complete versioned keyring and associated-data design.

#### PF-033 — Transaction import

Add:

- original/account-currency persistence;
- bill linkage;
- local date derivation;
- null enrichment support;
- history coverage updates;
- user-state preservation.

#### PF-034 — Bill import

Import and normalize payments, finance charges, and `allowsInstallments`.

#### PF-035 — Repeated-sync regression

Add field-level override preservation and bill-child idempotency.

#### PF-040 — Webhook route

Add all lifecycle events, workspace mapping, unmapped-event behavior, and no-provider-call-before-response test.

#### PF-041 — Queue repository

Add lease, heartbeat, active dedupe, and lost-lease completion protection.

#### PF-043 — Event handlers

Add Item deletion, waiting states, login-succeeded handling, V2 link selection, and replacement detection.

#### PF-054 — Manual override behavior

Replace the general manual flag with explicit field override modes and transaction user state.

#### PF-055 — Transfer/bill-payment/refund detectors

Use normalized bill payments/charges and require ambiguity review.

#### PF-060 — API framework and auth roles

Implement the three independent trust-boundary credentials.

#### PF-062 — Transaction list/detail/update endpoints

Add amount objects, notes/review state, override provenance/modes, bill linkage, and optimistic concurrency.

#### PF-066 — Card bill reconciliation

Use the normalized bill child entities and confirmation workflow.

#### PF-070 — Next.js/Auth.js foundation

Ensure only server-side code uses `WEB_TO_API_TOKEN`.

#### PF-072 — Transactions and correction workflow

Add notes, review state, explicit override modes, amount/currency display, and replacement context.

#### PF-076 — Cards/installments/recurring pages

Add bill payments, charges, and reconciliation UI.

#### PF-077 — Sync/health page

Add deleted, user-input-required, user-action-required, reauthorization, provider-error, and incomplete-history states.

#### PF-080 — MCP server foundation

Require two-hop authentication and API-only data access.

#### PF-083 — Card bill/installment/recurring tools

Add reconciliation summary and unresolved counts.

#### PF-096 — Secret rotation exercise

Expand to include encryption keyring rotation, data re-encryption, verification, and safe old-key retirement.

### 22.2 Add new tickets

#### PF-004 — Credential and trust-boundary ADR

Document the three credentials, route roles, token storage, rotation, and why MCP calls the API rather than PostgreSQL.

#### PF-005 — Workspace integrity ADR

Document composite FKs, provider uniqueness, category visibility, and repository scoping.

#### PF-006 — Provider identity and bill semantics ADR

Document transaction-ID replacement, signed card amounts, bill child entities, and economic-event deduplication.

#### PF-017 — Cross-workspace integrity constraints

Implement and test composite keys/FKs plus category-scope validation.

#### PF-018 — Transaction user state and effective view

Implement field-level overrides, notes, review status, optimistic concurrency, and `v_financial_transaction_effective`.

#### PF-019 — Bill child entities and reconciliation schema

Implement payments, finance charges, reconciliation, indexes, and views.

#### PF-026 — Pluggy lifecycle mapper

Map Item status/execution/error combinations to local states with fixture tests.

#### PF-036 — Account history coverage

Persist observed coverage and add analytics/API warnings.

#### PF-037 — Transaction replacement detector

Create candidate scoring, review queue, identity links, and safe user-state transfer.

#### PF-046 — Queue lease hardening

Implement heartbeats, lease reclaim, lost-lease protection, and active dedupe tests.

#### PF-057 — Missing-enrichment regression suite

Prove complete functionality when category and merchant enrichment are absent.

#### PF-058 — Currency and timezone regression suite

Cover original/account currency, mixed-currency warnings, and local-date boundaries.

#### PF-098 — Encryption key rotation run

Perform a documented non-production rotation, re-encrypt fixtures, test rollback, and record an audit event.

---

## 23. Revised Implementation Sequence

Apply these changes before beginning normal phase execution.

### Step 1 — Merge design amendments

- Update the main plan sections listed in §3.
- Resolve the MCP architecture decision.
- Add ADR tickets PF-004 through PF-006.
- Confirm no contradictory environment variable names remain.

### Step 2 — Finalize initial schema

Before generating migration `0001`:

- replace the transaction schema;
- add transaction user state and effective view;
- add bill child/reconciliation tables;
- add queue lease fields/indexes;
- add history coverage;
- apply workspace-scoped unique constraints and composite FKs;
- add category scope validation.

### Step 3 — Build fixtures before provider import

Create synthetic fixtures for signs, currencies, bills, lifecycle events, missing enrichment, and replacements. Provider mapping work is incomplete until these fixtures pass.

### Step 4 — Implement keyring and credential boundaries

Do this before storing real data. Do not import production financial payloads using the obsolete single-key design.

### Step 5 — Implement queue durability

Webhook processing and synchronization must not rely on a queue that lacks leases and active dedupe.

### Step 6 — Implement provider adapter and import

Use V2 cursor pagination, signed amounts, bill children, local dates, null enrichment, and coverage tracking from the first import.

### Step 7 — Implement effective analytics and review workflows

Build analytics on the effective transaction view. Add bill and replacement review before treating totals as reliable.

### Step 8 — Add web and MCP interfaces

MCP is enabled only after deterministic API totals, warnings, and role restrictions pass.

### If migrations or code already exist

Use expand/backfill/contract:

1. add new nullable columns/tables and indexes;
2. deploy dual-read/dual-write-compatible code where necessary;
3. backfill in bounded jobs;
4. verify counts, overrides, and reconciliation;
5. switch reads to effective views;
6. remove obsolete fields only in a later migration after backup.

Never rewrite an already-applied production migration.

---

## 24. `AGENTS.md` Additions

Add these non-negotiable instructions for Codex:

```text
- Treat personal-finance-platform-required-amendments.md as normative when it conflicts with the original plan.
- Do not create the initial production migration until all mandatory schema amendments are present.
- Never overwrite transaction_user_state during provider synchronization.
- Never infer credit-card financial role from amount sign alone.
- Never combine currencies without an explicit conversion amount/source.
- Every workspace-owned repository method must require workspaceId.
- Every workspace-owned foreign key must prevent cross-workspace references in PostgreSQL.
- Use only Pluggy GET /v2/transactions; do not call the deprecated page endpoint.
- Provider category and merchant fields are optional and may be null.
- MCP must call the read-only Finance API and must not connect directly to PostgreSQL.
- New encrypted writes use the active key version; old rows are decrypted by their stored key version.
- Queue completion is valid only while the worker still owns an unexpired lease.
- Do not commit or paste real financial payloads, secrets, transaction descriptions, amounts, dates, or identifiers.
```

---

## 25. Historical Integration Prompt (Completed)

This prompt was completed when producing implementation plan v1.1 and is retained for audit history:

```text
Read these two files in full:

1. personal-finance-platform-implementation-plan.md
2. personal-finance-platform-required-amendments.md

Update the main implementation plan so every mandatory amendment is incorporated into the appropriate existing section. The amendments file is normative wherever the documents conflict.

Requirements:
- Do not implement application code yet.
- Do not generate database migrations yet.
- Preserve the main plan's overall structure and numbering where practical.
- Replace obsolete schemas and environment variable names rather than appending contradictory alternatives.
- Update the backlog, acceptance criteria, AGENTS.md recommendations, runbooks, risk register, open decisions, and final checklist.
- Resolve the MCP architecture in favor of MCP calling the Finance API with a dedicated read-only credential.
- Ensure the revised transaction schema, bill normalization, keyring, authentication boundaries, queue leases, Pluggy lifecycle handling, history coverage, and workspace constraints agree across all sections.
- Add the official references from the amendments file.
- At the end, produce a concise change log listing every amended main-plan section.
- Before finishing, search the revised plan for these obsolete or ambiguous names and remove or explain every occurrence:
  DATA_ENCRYPTION_KEY
  INTERNAL_API_TOKEN
  FINANCE_API_TOKEN
  MCP_BEARER_TOKEN
  is_manual_override
  unique (provider, external_connection_id)
  unique (provider, external_account_id)
  unique (provider, external_bill_id)
  unique (provider, provider_transaction_id)
- Verify that no text still says provider sync can overwrite user fields.
- Verify that all promised transaction PATCH fields exist in the schema.
```

---

## 26. Definition of “Fully Incorporated”

The amendments are incorporated only when all of the following are true in the main plan:

### Schema

- transaction provider facts and user state are separated;
- notes and review state exist;
- original and account-currency amounts exist;
- internal/external bill linkage exists;
- field-level override semantics are explicit;
- bill payments and finance charges are normalized;
- transaction replacement links exist;
- queue heartbeat and lease fields exist;
- account history coverage exists;
- workspace-scoped unique constraints and composite FKs are documented;
- category visibility is database-enforced.

### Security

- versioned keyring and active key version replace the single key;
- rotation is resumable and tested;
- web-to-API, Hermes-to-MCP, and MCP-to-API credentials are separate;
- MCP direct database access is removed from the production design.

### Provider behavior

- all required Item events are handled;
- V2 transactions are used exclusively;
- transaction-ID replacement is modeled;
- credit-card sign rules are account-aware;
- UTC timestamps and local dates are both retained;
- premium enrichment fields may be null;
- history is described as up to 12 months and measured per account.

### Reliability and correctness

- active queue deduplication is enforced by PostgreSQL;
- a worker cannot complete a job after losing its lease;
- bill payments cannot double-count spending or cash flow;
- mixed currencies cannot be silently combined;
- incomplete-history warnings reach API, UI, and MCP;
- manual corrections survive synchronization and confirmed replacement.

### Backlog and testing

- every affected existing ticket is updated;
- new amendment tickets are present;
- the fixture and test matrices are included;
- production acceptance checks include key rotation, replacement continuity, bill reconciliation, workspace isolation, and null enrichment.

---

## 27. Official Verification Notes

The following current provider assumptions were checked against official Pluggy sources on August 22, 2026. They are time-sensitive and should be rechecked before commercialization or a major provider-adapter upgrade.

1. **Meu Pluggy personal use:** currently described as free without expiration, limited to the owner's nominal accounts, and not permitted for commercial/multi-customer use.\
   <https://www.pluggy.ai/meu-pluggy>

2. **Authentication:** backend API keys currently expire after two hours; Connect Tokens expire after 30 minutes and cannot retrieve product data.\
   <https://docs.pluggy.ai/reference/auth>

3. **Transactions:** current documentation describes retrieval of up to 12 months, cursor pagination, UTC transaction dates, `amountInAccountCurrency`, optional premium category/merchant fields, bill metadata, credit-card signs, and possible transaction-ID replacement.\
   <https://docs.pluggy.ai/docs/transactions>

4. **Current transaction endpoint:** `GET /v2/transactions` uses cursor pagination.\
   <https://docs.pluggy.ai/reference/transactions-list-by-cursor>

5. **Deprecated page endpoint:** official documentation lists the page-based endpoint as available only until December 31, 2026.\
   <https://docs.pluggy.ai/llms.txt>

6. **Credit-card bills:** bill objects include `allowsInstallments`, `payments`, and `financeCharges`.\
   <https://docs.pluggy.ai/docs/credit-card-bills>

7. **Categorization:** category may be null; categorization is currently described as trial/premium after the trial.\
   <https://docs.pluggy.ai/docs/transaction-categories>

8. **Enrichment:** transaction enrichment is currently described as a premium feature requiring enablement.\
   <https://docs.pluggy.ai/docs/enrich-api>

9. **Webhooks:** current events include Item deletion, waiting-for-user states, login success, and transaction events. Pluggy currently requires a `2xx` response in under five seconds and recommends asynchronous processing.\
   <https://docs.pluggy.ai/docs/webhooks>

10. **Item lifecycle:** current Item status and execution-status documentation distinguishes updating, successful, partial, login error, outdated, user input, authorization pending, and deletion behavior.\
    <https://docs.pluggy.ai/docs/item-lifecycle>\
    <https://docs.pluggy.ai/docs/errors-validations>

---

## 28. Final Implementation Principle

The system must preserve three independent truths:

```text
Provider evidence
  -> what Pluggy and the financial institution supplied

System interpretation
  -> deterministic local normalization, reconciliation, and classification

User decision
  -> notes, review, manual overrides, confirmed links, and corrections
```

Provider refreshes may change the first layer and cause the second layer to be recalculated. They must not erase the third layer.

That separation, combined with workspace integrity, bill reconciliation, a rotatable encryption keyring, and lease-based jobs, is the minimum safe foundation for importing real personal financial data and later evolving the project into a commercial product.
