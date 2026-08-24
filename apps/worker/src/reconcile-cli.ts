import { randomUUID } from 'node:crypto';

import { parseWorkerConfig } from '@cashcount/config';
import {
  AccountImportRepository,
  BillImportRepository,
  createDatabaseClient,
  PayloadEncryptionService,
  ProviderConnectionRepository,
  ReconciliationRepository,
  TransactionImportRepository,
  TransactionReplacementRepository,
} from '@cashcount/db';
import {
  PluggyApiKeyProvider,
  PluggyAuthenticatedHttpClient,
  PluggyDataClient,
} from '@cashcount/provider-pluggy';

import { runFullImport } from './full-import.js';
import {
  parseReconciliationArguments,
  ReconciliationUsageError,
  runScheduledReconciliation,
} from './scheduled-reconciliation.js';

async function main(): Promise<void> {
  const workspaceId = parseReconciliationArguments(process.argv.slice(2));
  const config = parseWorkerConfig(process.env);
  const databaseUrl = config.DATABASE_URL ?? config.LOCAL_DATABASE_URL;
  if (databaseUrl === undefined) throw new Error('Worker database configuration is unavailable.');

  const client = createDatabaseClient(databaseUrl);
  try {
    const apiKeyProvider = new PluggyApiKeyProvider({
      baseUrl: config.PLUGGY_BASE_URL,
      clientId: config.PLUGGY_CLIENT_ID,
      clientSecret: config.PLUGGY_CLIENT_SECRET,
    });
    const provider = new PluggyDataClient({
      httpClient: new PluggyAuthenticatedHttpClient({
        apiKeyProvider,
        baseUrl: config.PLUGGY_BASE_URL,
      }),
    });
    const encryption = new PayloadEncryptionService({
      activeKeyVersion: config.DATA_ENCRYPTION_ACTIVE_KEY_VERSION,
      keyring: config.DATA_ENCRYPTION_KEYRING_JSON,
    });
    const accountPersistence = new AccountImportRepository(client.database);
    const billPersistence = new BillImportRepository(client.database);
    const connectionPersistence = new ProviderConnectionRepository(client.database);
    const persistence = new ReconciliationRepository(client.pool);
    const replacementDetector = new TransactionReplacementRepository(client.pool);
    const transactionPersistence = new TransactionImportRepository(client.database);
    const result = await runScheduledReconciliation({
      applyConnectionSnapshot: async (scope, providerConnectionId, snapshot) => {
        const assigned = await connectionPersistence.assignDiscoveredConnections(scope, [snapshot]);
        if (assigned.length !== 1 || assigned[0]?.id !== providerConnectionId) {
          throw new Error('Provider Item snapshot resolved outside its reconciliation mapping.');
        }
      },
      fullImport: async (scope, providerConnectionId) =>
        runFullImport({
          accountPersistence,
          billPersistence,
          encryption,
          provider,
          providerConnectionId,
          replacementDetector,
          transactionPersistence,
          triggerType: 'SCHEDULED',
          workspaceId: scope,
        }),
      persistence,
      provider,
      reconciliationRunId: randomUUID(),
      workspaceId,
    });
    console.log(
      `Scheduled reconciliation completed: targets=${result.targetsSeen} reconciled=${result.connectionsReconciled} action_required=${result.actionRequired} deleted=${result.connectionsDeleted} failed=${result.connectionsFailed} overlap_skipped=${String(result.overlapSkipped)}.`,
    );
    if (result.connectionsFailed > 0) process.exitCode = 1;
  } finally {
    await client.pool.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ReconciliationUsageError) {
    console.error(error.message);
  } else {
    console.error('Scheduled reconciliation failed.');
  }
  process.exitCode = 1;
}
