import { parseWorkerConfig } from '@cashcount/config';
import {
  AccountImportRepository,
  BillImportRepository,
  createDatabaseClient,
  PayloadEncryptionService,
  TransactionImportRepository,
  TransactionReplacementRepository,
} from '@cashcount/db';
import {
  PluggyApiKeyProvider,
  PluggyAuthenticatedHttpClient,
  PluggyDataClient,
} from '@cashcount/provider-pluggy';

import { FullImportUsageError, parseFullImportArguments, runFullImport } from './full-import.js';

async function main(): Promise<void> {
  const { providerConnectionId, workspaceId } = parseFullImportArguments(process.argv.slice(2));
  const config = parseWorkerConfig(process.env);
  const databaseUrl = config.DATABASE_URL ?? config.LOCAL_DATABASE_URL;
  if (databaseUrl === undefined) throw new Error('Worker database configuration is unavailable.');

  const databaseClient = createDatabaseClient(databaseUrl);
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
    const result = await runFullImport({
      accountPersistence: new AccountImportRepository(databaseClient.database),
      billPersistence: new BillImportRepository(databaseClient.database),
      encryption,
      provider,
      providerConnectionId,
      replacementDetector: new TransactionReplacementRepository(databaseClient.pool),
      transactionPersistence: new TransactionImportRepository(databaseClient.database),
      workspaceId,
    });
    console.log(
      `Full import completed: accounts=${result.accounts.accountsSeen} transactions=${result.transactions.transactionsSeen} bills=${result.bills.billsSeen}.`,
    );
  } finally {
    await databaseClient.pool.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof FullImportUsageError) {
    console.error(error.message);
  } else {
    console.error('Full import failed.');
  }
  process.exitCode = 1;
}
