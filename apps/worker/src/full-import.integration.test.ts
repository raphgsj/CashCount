import { randomUUID } from 'node:crypto';

import { parseDatabaseConfig } from '@cashcount/config';
import {
  mcpUnclassifiedSummarySchema,
  webUnclassifiedTransactionSchema,
} from '@cashcount/contracts';
import {
  AccountImportRepository,
  BillImportRepository,
  ClassificationQualityRepository,
  ClassificationRuleRepository,
  createDatabaseClient,
  PayloadEncryptionService,
  runMigrations,
  seedSyntheticIdentity,
  syntheticIdentitySeed,
  TransactionImportRepository,
  TransactionReplacementRepository,
  TransactionUserStateRepository,
} from '@cashcount/db';
import {
  PluggyApiKeyProvider,
  PluggyAuthenticatedHttpClient,
  PluggyDataClient,
} from '@cashcount/provider-pluggy';
import {
  pluggyAccountBody,
  pluggyBillsBody,
  pluggyFixtureIds,
  pluggyItemLifecycleFixtures,
  pluggyTransactionMatrixBody,
} from '@cashcount/test-fixtures';
import { describe, expect, it, vi } from 'vitest';

import { runFullImport } from './full-import.js';

const firstLifecycleFixture = pluggyItemLifecycleFixtures[0];
if (firstLifecycleFixture === undefined) throw new Error('Expected a lifecycle fixture.');

function quoteDatabase(identifier: string): string {
  if (!/^cashcount_full_import_[0-9a-f]+$/u.test(identifier)) {
    throw new Error('Refusing to quote an unexpected integration database identifier.');
  }
  return `"${identifier}"`;
}

function jsonResponse(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' }, status: 200 });
}

function fixtureProvider(requestedPaths: string[]): PluggyDataClient {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);
    if (url.pathname === '/auth') return jsonResponse('{"accessToken":"synthetic-api-key"}');
    if (url.pathname === `/items/${pluggyFixtureIds.connection}`) {
      return jsonResponse(firstLifecycleFixture.responseBody);
    }
    if (url.pathname === '/accounts') {
      return jsonResponse(`{"results":[${pluggyAccountBody}]}`);
    }
    if (url.pathname === '/v2/transactions') return jsonResponse(pluggyTransactionMatrixBody);
    if (url.pathname === '/bills') return jsonResponse(pluggyBillsBody);
    throw new Error(`Unexpected synthetic provider path ${url.pathname}.`);
  });
  const apiKeyProvider = new PluggyApiKeyProvider({
    baseUrl: 'https://provider.example.test',
    clientId: 'synthetic-client-id',
    clientSecret: 'synthetic-client-secret',
    fetchImpl,
    requestId: () => 'synthetic-auth-request',
  });
  return new PluggyDataClient({
    httpClient: new PluggyAuthenticatedHttpClient({
      apiKeyProvider,
      baseUrl: 'https://provider.example.test',
      fetchImpl,
      maxRetries: 0,
      requestId: () => 'synthetic-data-request',
    }),
  });
}

describe('full import regression', () => {
  it('repeats sanitized full import without duplicates or user-state overwrite', async () => {
    const { databaseUrl } = parseDatabaseConfig(process.env);
    const databaseName = `cashcount_full_import_${randomUUID().replaceAll('-', '')}`;
    const databaseUrlObject = new URL(databaseUrl);
    databaseUrlObject.pathname = `/${databaseName}`;
    const admin = createDatabaseClient(databaseUrl);

    try {
      await admin.pool.query(`create database ${quoteDatabase(databaseName)} template template0`);
      await runMigrations(databaseUrlObject.toString());
      await seedSyntheticIdentity(databaseUrlObject.toString(), 'test');

      const client = createDatabaseClient(databaseUrlObject.toString());
      try {
        const workspaceId = syntheticIdentitySeed.workspace.id;
        const providerConnectionId = '40000000-0000-4000-8000-000000000035';
        await client.pool.query(
          `insert into provider_connection (
             id, workspace_id, provider, external_connection_id, external_connector_id, display_name
           ) values ($1, $2, 'PLUGGY', $3, '601', 'Synthetic Fixture Bank')`,
          [providerConnectionId, workspaceId, pluggyFixtureIds.connection],
        );
        const paths: string[] = [];
        const provider = fixtureProvider(paths);
        const encryption = new PayloadEncryptionService({
          activeKeyVersion: 11,
          keyring: new Map([[11, new Uint8Array(32).fill(35)]]),
        });
        const common = {
          accountPersistence: new AccountImportRepository(client.database),
          billPersistence: new BillImportRepository(client.database),
          encryption,
          provider,
          providerConnectionId,
          replacementDetector: new TransactionReplacementRepository(client.pool),
          transactionPersistence: new TransactionImportRepository(client.database),
          workspaceId,
        };

        const initial = await runFullImport({
          ...common,
          now: () => new Date('2026-08-23T21:00:00.000Z'),
          triggerType: 'INITIAL',
        });
        expect(initial).toMatchObject({
          accounts: { accountsInserted: 1, accountsSeen: 1, rawSnapshotsInserted: 1 },
          bills: {
            billsInserted: 1,
            billsSeen: 1,
            financeChargesInserted: 1,
            paymentsInserted: 1,
            rawSnapshotsInserted: 3,
            transactionsLinked: 1,
          },
          transactions: { transactionsInserted: 4, transactionsSeen: 4 },
        });

        const transaction = await client.pool.query<{ id: string }>(
          `select id from financial_transaction
           where workspace_id = $1 and provider_transaction_id = '30000000-0000-4000-8000-000000000001'`,
          [workspaceId],
        );
        const transactionId = transaction.rows[0]?.id;
        if (transactionId === undefined) throw new Error('Expected an imported transaction.');
        const missingCategoryId = '70000000-0000-4000-8000-000000000057';
        await client.pool.query(
          `insert into category (id, workspace_id, code, kind, name_en, name_pt_br)
           values ($1::uuid, $2, 'custom.' || $1::text, 'EXPENSE',
                   'Recovered classification', 'Classificação recuperada')`,
          [missingCategoryId, workspaceId],
        );
        const missingTransactions = await client.pool.query<{
          id: string;
          provider_transaction_id: string;
        }>(
          `select id, provider_transaction_id from financial_transaction
           where workspace_id = $1 and provider_transaction_id in
             ('30000000-0000-4000-8000-000000000002',
              '30000000-0000-4000-8000-000000000003',
              '30000000-0000-4000-8000-000000000004')`,
          [workspaceId],
        );
        const missingByProviderId = new Map(
          missingTransactions.rows.map((row) => [row.provider_transaction_id, row.id]),
        );
        const classifiedMissingId = missingByProviderId.get('30000000-0000-4000-8000-000000000002');
        const billLinkedMissingId = missingByProviderId.get('30000000-0000-4000-8000-000000000003');
        const unconvertedMissingId = missingByProviderId.get(
          '30000000-0000-4000-8000-000000000004',
        );
        if (
          classifiedMissingId === undefined ||
          billLinkedMissingId === undefined ||
          unconvertedMissingId === undefined
        ) {
          throw new Error('Expected every missing-enrichment fixture transaction.');
        }
        const ruleRepository = new ClassificationRuleRepository(client.pool);
        await ruleRepository.createRule(workspaceId, {
          actions: {
            operations: [
              { categoryId: missingCategoryId, type: 'SET_CATEGORY' },
              { financialRole: 'REFUND', type: 'SET_FINANCIAL_ROLE' },
            ],
            version: '1',
          },
          actorId: 'missing-enrichment-regression',
          conditions: {
            root: {
              field: 'transaction.descriptionNormalized',
              operator: 'eq',
              type: 'PREDICATE',
              value: 'synthetic unresolved credit',
            },
            version: '1',
          },
          name: 'Classify missing provider enrichment',
          priority: 100,
          source: 'USER',
        });
        await expect(
          ruleRepository.evaluateTransaction(workspaceId, classifiedMissingId),
        ).resolves.toMatchObject({
          evaluation: { actions: { category: { value: missingCategoryId } } },
          newlyRecordedMatches: 1,
        });
        const userStateRepository = new TransactionUserStateRepository(client.pool);
        await userStateRepository.update({
          actorType: 'USER',
          expectedVersion: 0,
          financialRoleOverride: { mode: 'SET', value: 'FEE' },
          notes: 'Synthetic user-owned note',
          reviewStatus: 'CONFIRMED',
          transactionId,
          workspaceId,
        });

        const repeated = await runFullImport({
          ...common,
          now: () => new Date('2026-08-23T22:00:00.000Z'),
        });
        expect(repeated).toMatchObject({
          accounts: { accountsInserted: 0, accountsSeen: 1, rawSnapshotsInserted: 0 },
          bills: {
            billsInserted: 0,
            billsUpdated: 0,
            financeChargesInserted: 0,
            financeChargesUpdated: 0,
            paymentsInserted: 0,
            paymentsUpdated: 0,
            rawSnapshotsInserted: 0,
            transactionsLinked: 0,
          },
          transactions: {
            transactionsDeleted: 0,
            transactionsInserted: 0,
            transactionsSeen: 4,
            transactionsUpdated: 0,
          },
        });

        const counts = await client.pool.query<{
          accounts: number;
          bills: number;
          charges: number;
          payments: number;
          raw_objects: number;
          transactions: number;
        }>(
          `select
             (select count(*)::integer from financial_account where workspace_id = $1) as accounts,
             (select count(*)::integer from financial_transaction where workspace_id = $1) as transactions,
             (select count(*)::integer from credit_card_bill where workspace_id = $1) as bills,
             (select count(*)::integer from credit_card_bill_payment where workspace_id = $1) as payments,
             (select count(*)::integer from credit_card_bill_finance_charge where workspace_id = $1) as charges,
             (select count(*)::integer from provider_raw_object where workspace_id = $1) as raw_objects`,
          [workspaceId],
        );
        expect(counts.rows[0]).toEqual({
          accounts: 1,
          bills: 1,
          charges: 1,
          payments: 1,
          raw_objects: 8,
          transactions: 4,
        });
        await expect(userStateRepository.get(workspaceId, transactionId)).resolves.toMatchObject({
          financialRoleOverride: 'FEE',
          notes: 'Synthetic user-owned note',
          reviewStatus: 'CONFIRMED',
          version: 1,
        });
        const activeKeys = await client.pool.query<{ count: number }>(
          `select count(*)::integer as count from provider_raw_object
           where workspace_id = $1 and key_version = 11`,
          [workspaceId],
        );
        expect(activeKeys.rows[0]?.count).toBe(8);

        const classified = await client.pool.query<{
          effective_category_id: string | null;
          effective_category_source: string;
          effective_financial_role: string;
          effective_merchant_id: string | null;
          provider_category_id: string | null;
          provider_category_name: string | null;
          spend_effect_amount: string | null;
        }>(
          `select effective_category_id, effective_category_source,
                  effective_financial_role, effective_merchant_id,
                  provider_category_id, provider_category_name, spend_effect_amount
           from v_transaction_spend_effect where workspace_id = $1 and id = $2`,
          [workspaceId, classifiedMissingId],
        );
        expect(classified.rows[0]).toEqual({
          effective_category_id: missingCategoryId,
          effective_category_source: 'RULE',
          effective_financial_role: 'REFUND',
          effective_merchant_id: null,
          provider_category_id: null,
          provider_category_name: null,
          spend_effect_amount: '-20.100000',
        });

        const billEvidence = await client.pool.query<{
          credit_card_bill_id: string | null;
          effective_category_id: string | null;
          effective_merchant_id: string | null;
          has_unconverted_currency: boolean;
          linked_transaction_total: string;
          reconciliation_status: string;
        }>(
          `select effective.credit_card_bill_id, effective.effective_category_id,
                  effective.effective_merchant_id, effective.has_unconverted_currency,
                  reconciliation.linked_transaction_total,
                  reconciliation.reconciliation_status
           from v_financial_transaction_effective effective
           join v_credit_card_bill_reconciliation reconciliation
             on reconciliation.workspace_id = effective.workspace_id
            and reconciliation.credit_card_bill_id = effective.credit_card_bill_id
           where effective.workspace_id = $1 and effective.id = $2`,
          [workspaceId, billLinkedMissingId],
        );
        expect(billEvidence.rows[0]).toMatchObject({
          effective_category_id: null,
          effective_merchant_id: null,
          has_unconverted_currency: false,
          linked_transaction_total: '67.890123',
          reconciliation_status: 'NEEDS_REVIEW',
        });
        expect(billEvidence.rows[0]?.credit_card_bill_id).not.toBeNull();

        const qualityRepository = new ClassificationQualityRepository(client.pool);
        const quality = await qualityRepository.getReport(workspaceId);
        expect(quality).toMatchObject({
          classifiedCount: 1,
          totalCount: 4,
          unclassifiedCount: 3,
          unclassifiedPercentage: '75.0000',
        });
        expect(quality.sourceDistribution.find(({ source }) => source === 'RULE')).toEqual({
          count: 1,
          percentage: '25.0000',
          source: 'RULE',
        });
        const unclassified = await qualityRepository.listUnclassified(workspaceId, { limit: 10 });
        const missing = unclassified.items.find(({ id }) => id === unconvertedMissingId);
        if (missing === undefined) throw new Error('Expected the unconverted unclassified item.');
        const warningCodes = [
          'MISSING_CATEGORY' as const,
          'MISSING_MERCHANT' as const,
          ...(missing.hasUnconvertedCurrency ? (['UNCONVERTED_CURRENCY'] as const) : []),
        ];
        expect(
          webUnclassifiedTransactionSchema.parse({
            amount: {
              currency: missing.accountCurrency,
              hasUnconvertedCurrency: missing.hasUnconvertedCurrency,
              value: missing.accountCurrencyAmountSigned,
            },
            category: null,
            classificationState: 'UNCLASSIFIED',
            description: {
              normalized: missing.descriptionNormalized,
              original: missing.descriptionOriginal,
            },
            id: missing.id,
            merchant: null,
            providerCategoryName: missing.providerCategoryName,
            transactionDate: missing.transactionLocalDate,
            warnings: warningCodes,
          }),
        ).toMatchObject({ category: null, merchant: null });
        const mcpSummary = mcpUnclassifiedSummarySchema.parse({
          asOf: '2026-08-23T22:00:00.000Z',
          currency: missing.accountCurrency,
          freshnessWarning: null,
          policyVersion: 'classification-quality-v1',
          requestedPeriod: { from: '2026-08-01', to: '2026-08-31' },
          sample: [
            {
              amountSigned: missing.accountCurrencyAmountSigned,
              category: null,
              financialRole: missing.financialRole,
              merchant: null,
              transactionDate: missing.transactionLocalDate,
              warnings: warningCodes,
            },
          ],
          unclassifiedCount: quality.unclassifiedCount,
        });
        expect(mcpSummary.sample[0]).toMatchObject({ category: null, merchant: null });
        expect(Object.keys(mcpSummary.sample[0] ?? {})).not.toContain('id');
        expect(paths.filter((path) => path === '/v2/transactions')).toHaveLength(2);
        expect(paths.some((path) => path.includes('/transactions'))).toBe(true);
        expect(paths.some((path) => path === '/transactions')).toBe(false);
      } finally {
        await client.pool.end();
      }
    } finally {
      await admin.pool.query(`drop database if exists ${quoteDatabase(databaseName)}`);
      await admin.pool.end();
    }
  }, 30_000);
});
