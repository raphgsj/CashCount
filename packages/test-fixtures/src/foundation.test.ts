import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

const workspaces = [
  ['apps/web', '@cashcount/web'],
  ['apps/api', '@cashcount/api'],
  ['apps/worker', '@cashcount/worker'],
  ['apps/mcp', '@cashcount/mcp'],
  ['packages/config', '@cashcount/config'],
  ['packages/contracts', '@cashcount/contracts'],
  ['packages/db', '@cashcount/db'],
  ['packages/domain', '@cashcount/domain'],
  ['packages/provider-core', '@cashcount/provider-core'],
  ['packages/provider-pluggy', '@cashcount/provider-pluggy'],
  ['packages/classification', '@cashcount/classification'],
  ['packages/analytics', '@cashcount/analytics'],
  ['packages/observability', '@cashcount/observability'],
  ['packages/test-fixtures', '@cashcount/test-fixtures'],
] as const;

const architectureDecisionRecords = [
  '0001-typescript-monorepo.md',
  '0002-postgresql-system-of-record.md',
  '0003-provider-adapter-boundary.md',
  '0004-postgres-backed-job-queue.md',
  '0005-vercel-bff-and-railway-api.md',
  '0006-read-only-mcp.md',
  '0007-raw-payload-encryption.md',
  '0008-credential-and-trust-boundaries.md',
  '0009-workspace-integrity.md',
  '0010-provider-identity-and-bill-semantics.md',
] as const;

describe('repository foundation', () => {
  it.each(workspaces)('%s declares its expected package identity and checks', (path, name) => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, path, 'package.json'), 'utf8'));

    expect(manifest).toMatchObject({
      name,
      private: true,
      scripts: {
        build: expect.any(String),
        lint: expect.any(String),
        typecheck: expect.any(String),
      },
    });
  });

  it('pins the supported Node and pnpm versions', () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));

    expect(manifest).toMatchObject({
      packageManager: 'pnpm@11.22.0',
      engines: {
        node: '24.19.0',
        pnpm: '11.22.0',
      },
    });
  });

  it('keeps the environment example free of assigned values', () => {
    const environmentLines = readFileSync(join(repositoryRoot, '.env.example'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    expect(environmentLines.length).toBeGreaterThan(0);
    expect(environmentLines.every((line) => /^[A-Z][A-Z0-9_]*=$/.test(line))).toBe(true);
  });

  it('defines a persistent and health-checked local PostgreSQL service', () => {
    const compose = readFileSync(join(repositoryRoot, 'infra', 'docker-compose.yml'), 'utf8');

    expect(compose).toContain('image: postgres:18.6-alpine3.24');
    expect(compose).toContain("'127.0.0.1:${POSTGRES_PORT:-5432}:5432'");
    expect(compose).toContain('pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"');
    expect(compose).toContain('postgres_data:/var/lib/postgresql');
    expect(compose).not.toContain('POSTGRES_HOST_AUTH_METHOD');
  });

  it('keeps migrations explicit and verifies them from an empty PostgreSQL database in CI', () => {
    const databaseManifest = JSON.parse(
      readFileSync(join(repositoryRoot, 'packages', 'db', 'package.json'), 'utf8'),
    );
    const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

    expect(databaseManifest.scripts).toMatchObject({
      'db:check': expect.any(String),
      'db:generate': expect.any(String),
      'db:migrate': expect.any(String),
      'db:seed': expect.any(String),
      'test:integration': expect.any(String),
    });
    expect(workflow).toContain('postgres:18.6-alpine3.24');
    expect(workflow).toContain('pnpm db:check');
    expect(workflow).toContain('pnpm test:integration');

    for (const application of ['web', 'api', 'worker', 'mcp']) {
      const manifest = JSON.parse(
        readFileSync(join(repositoryRoot, 'apps', application, 'package.json'), 'utf8'),
      );
      const commands = Object.values(manifest.scripts ?? {}).join('\n');

      expect(commands).not.toContain('db:migrate');
    }
  });

  it('defines the PF-019 Phase 1 database boundary', () => {
    const schema = readFileSync(join(repositoryRoot, 'packages', 'db', 'src', 'schema.ts'), 'utf8');
    const seed = readFileSync(join(repositoryRoot, 'packages', 'db', 'src', 'seed.ts'), 'utf8');
    const viewsMigration = readFileSync(
      join(repositoryRoot, 'packages', 'db', 'drizzle', '0005_initial_views.sql'),
      'utf8',
    );
    const integrityMigration = readFileSync(
      join(repositoryRoot, 'packages', 'db', 'drizzle', '0006_workspace_integrity.sql'),
      'utf8',
    );
    const userStateRepository = readFileSync(
      join(repositoryRoot, 'packages', 'db', 'src', 'transaction-user-state-repository.ts'),
      'utf8',
    );
    const billReconciliationMigration = readFileSync(
      join(repositoryRoot, 'packages', 'db', 'drizzle', '0007_bill_reconciliation.sql'),
      'utf8',
    );

    expect(schema).toContain("'app_user'");
    expect(schema).toContain("'workspace'");
    expect(schema).toContain("'workspace_member'");
    expect(schema).toContain("'provider_connection'");
    expect(schema).toContain("'provider_raw_object'");
    expect(schema).toContain("'encryption_rotation_run'");
    expect(schema).toContain("'canonicalization_version'");
    expect(schema).toContain("'webhook_event'");
    expect(schema).toContain("'job_queue'");
    expect(schema).toContain("'sync_run'");
    expect(schema).toContain('sync_run_workspace_provider_connection_fk');
    expect(schema).toContain('job_queue_active_dedupe_uq');
    expect(schema).toContain("'financial_account'");
    expect(schema).toContain("'credit_card_bill'");
    expect(schema).toContain("'credit_card_bill_payment'");
    expect(schema).toContain("'credit_card_bill_finance_charge'");
    expect(schema).toContain("'bill_payment_reconciliation'");
    expect(schema).toContain("'category'");
    expect(schema).toContain("'merchant'");
    expect(schema).toContain("'merchant_alias'");
    expect(schema).toContain("'financial_transaction'");
    expect(schema).toContain("'transaction_user_state'");
    expect(schema).toContain("'transaction_identity_link'");
    expect(schema).toContain("'transaction_revision'");
    expect(schema).toContain("numeric('provider_amount_signed', { precision: 20, scale: 6 })");
    expect(schema).toContain('financial_transaction_workspace_financial_account_fk');
    expect(schema).toContain("'classification_rule'");
    expect(schema).toContain("'classification_decision'");
    expect(schema).toContain("'installment_series'");
    expect(schema).toContain("'recurring_series'");
    expect(schema).toContain("'tag'");
    expect(schema).toContain("'transaction_tag'");
    expect(schema).toContain("'audit_event'");
    expect(schema).toContain('financial_transaction_workspace_installment_series_fk');
    for (const view of [
      'v_financial_transaction_effective',
      'v_transaction_spend_effect',
      'v_transaction_cashflow_effect',
      'v_credit_card_bill_reconciliation',
      'v_account_history_coverage',
      'v_transactions_needing_review',
      'v_transaction_replacement_review',
      'v_monthly_spend_by_category',
      'v_monthly_spend_by_merchant',
      'v_installment_commitments',
      'v_account_data_freshness',
      'v_unclassified_transactions',
    ]) {
      expect(viewsMigration).toContain(`CREATE VIEW "${view}"`);
    }
    expect(viewsMigration).not.toContain('MATERIALIZED VIEW');
    expect(integrityMigration).toContain('cashcount_validate_classification_rule_category_action');
    expect(integrityMigration).toContain('classification_rule_category_action_visibility_trg');
    expect(userStateRepository).toContain('class TransactionUserStateRepository');
    expect(userStateRepository).toContain('workspaceId: string');
    expect(userStateRepository).toContain("mode: 'CLEAR'");
    expect(userStateRepository).toContain("mode: 'INHERIT'");
    expect(userStateRepository).toContain("mode: 'SET'");
    expect(userStateRepository).toContain('for update of ft');
    expect(userStateRepository).not.toContain('getById(');
    expect(schema).toContain("'reconciliation_currency_tolerance'");
    expect(schema).toContain('bill_payment_reconciliation_active_transaction_uq');
    expect(billReconciliationMigration).toContain(
      'cashcount_validate_active_bill_payment_reconciliation',
    );
    expect(billReconciliationMigration).toContain('bill_payment_reconciliation_evidence_trg');
    expect(billReconciliationMigration).toContain("VALUES ('BRL', 0.010000)");
    expect(seed).toContain('owner@example.test');
    expect(seed).toContain('Synthetic Personal Finance');
  });

  it('defines the PF-021 exact values and transaction-policy boundary', () => {
    const domainManifest = JSON.parse(
      readFileSync(join(repositoryRoot, 'packages', 'domain', 'package.json'), 'utf8'),
    );
    const money = readFileSync(
      join(repositoryRoot, 'packages', 'domain', 'src', 'money.ts'),
      'utf8',
    );
    const dates = readFileSync(
      join(repositoryRoot, 'packages', 'domain', 'src', 'dates.ts'),
      'utf8',
    );
    const policy = readFileSync(
      join(repositoryRoot, 'packages', 'domain', 'src', 'transaction-policy.ts'),
      'utf8',
    );

    expect(domainManifest.dependencies).toEqual({ 'decimal.js': '10.6.0' });
    expect(money).toContain('class Money');
    expect(money).toContain('toJSON(): MoneyJson');
    expect(money).toContain('MoneyCurrencyMismatchError');
    expect(money).not.toContain('parseFloat');
    expect(dates).toContain('deriveFinancialDate');
    expect(dates).toContain('Intl.DateTimeFormat');
    expect(dates).toContain('parseBillForecastMonth');
    expect(policy).toContain('classifyTransaction');
    expect(policy).toContain('calculateTransactionEffects');
    expect(policy).toContain('BILL_EVIDENCE_NOT_COUNTED');
    expect(policy).toContain('UNCONVERTED_CURRENCY');
    expect(policy).not.toContain('parseFloat');
  });

  it.each(architectureDecisionRecords)('%s records a complete accepted decision', (fileName) => {
    const record = readFileSync(join(repositoryRoot, 'docs', 'adr', fileName), 'utf8');

    expect(record).toContain('- **Status:** Accepted');
    expect(record).toContain('## Context');
    expect(record).toContain('## Decision');
    expect(record).toContain('## Alternatives considered');
    expect(record).toContain('## Consequences');
  });

  it('records the complete credential and trust-boundary decision', () => {
    const record = readFileSync(
      join(repositoryRoot, 'docs', 'adr', '0008-credential-and-trust-boundaries.md'),
      'utf8',
    );

    expect(record).toContain('## Credential role and storage matrix');
    expect(record).toContain('## Authorization binding and verification');
    expect(record).toContain('## Rotation protocol');
    expect(record).toContain('## Why MCP calls the read-only Finance API');
    expect(record).toContain('## Adjacent credentials and exclusions');
    expect(record).toContain(
      'Database credentials stay only in services with repository responsibilities',
    );
  });

  it('records the complete workspace-integrity decision', () => {
    const record = readFileSync(
      join(repositoryRoot, 'docs', 'adr', '0009-workspace-integrity.md'),
      'utf8',
    );

    expect(record).toContain('- **Tickets:** PF-003; expanded by PF-005');
    expect(record).toContain('## Provider identity and uniqueness');
    expect(record).toContain('## Composite foreign-key coverage');
    expect(record).toContain('## Category uniqueness and visibility');
    expect(record).toContain('## Repository scoping contract');
    expect(record).toContain('## Verification matrix');
    expect(record).toContain('Every workspace-owned table with a surrogate `id` adds');
    expect(record).toContain('getTransactionById(workspaceId, transactionId)');
    expect(record).toContain('cross-workspace category assignment fails');
  });

  it('records the complete provider-identity and bill-semantics decision', () => {
    const record = readFileSync(
      join(repositoryRoot, 'docs', 'adr', '0010-provider-identity-and-bill-semantics.md'),
      'utf8',
    );

    expect(record).toContain('- **Tickets:** PF-003; expanded by PF-006');
    expect(record).toContain('## Identity layers');
    expect(record).toContain('## Provider-ID lifecycle and replacement');
    expect(record).toContain('## Signed amount and financial-role policy');
    expect(record).toContain('## Bill child entities');
    expect(record).toContain('## Economic-event reconciliation');
    expect(record).toContain('## Verification matrix');
    expect(record).toContain('The initial auto-confirm threshold is `>= 0.95`');
    expect(record).toContain('Unresolved negative card entry');
    expect(record).toContain('provider synchronization never writes `transaction_user_state`');
  });

  it('records the implementation boundary and next ticket', () => {
    const readme = readFileSync(join(repositoryRoot, 'README.md'), 'utf8');
    const agentInstructions = readFileSync(join(repositoryRoot, 'AGENTS.md'), 'utf8');
    const adrIndex = readFileSync(join(repositoryRoot, 'docs', 'adr', 'README.md'), 'utf8');

    expect(readme).toContain(
      '**Phases 0 through 5 are complete; Phase 6 is in progress through PF-063:**',
    );
    expect(readme).toContain('**PF-064: Spending and cash-flow analytics**');
    expect(readme).toContain('Fastify Finance API framework, service auth');
    expect(agentInstructions).toContain('## Current implementation state');
    expect(agentInstructions).toContain('Phase 0 is complete: PF-001 through PF-006.');
    expect(agentInstructions).toContain('Phase 1 is complete: PF-010 through PF-019');
    expect(agentInstructions).toContain('PF-046 completes Phase 4');
    expect(agentInstructions).toContain('PF-050 starts Phase 5');
    expect(agentInstructions).toContain('PF-058 completes Phase 5');
    expect(agentInstructions).toContain('PF-060 starts Phase 6');
    expect(agentInstructions).toContain('PF-061 adds bounded fixed-workspace web-owner reads');
    expect(agentInstructions).toContain('PF-062 adds fixed-workspace web-owner transaction');
    expect(agentInstructions).toContain('PF-063 adds bounded fixed-workspace web-owner category');
    expect(agentInstructions).toContain('The next ticket is PF-064');
    expect(agentInstructions).toContain('Update this section and the root README together');
    expect(adrIndex).toContain('These records complete the');
    expect(adrIndex).toContain('Phase 0 decision backlog');
  });
});
