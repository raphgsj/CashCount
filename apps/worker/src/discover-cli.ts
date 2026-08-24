import { parseWorkerConfig } from '@cashcount/config';
import { createDatabaseClient, ProviderConnectionRepository } from '@cashcount/db';
import {
  PluggyApiKeyProvider,
  PluggyAuthenticatedHttpClient,
  PluggyDataClient,
} from '@cashcount/provider-pluggy';

import {
  ConnectionDiscoveryUsageError,
  discoverConnections,
  parseConnectionDiscoveryArguments,
} from './discover-connections.js';

async function main(): Promise<void> {
  const workspaceId = parseConnectionDiscoveryArguments(process.argv.slice(2));
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
    await discoverConnections({
      provider,
      repository: new ProviderConnectionRepository(databaseClient.database),
      workspaceId,
      writeLine: (line) => console.log(line),
    });
  } finally {
    await databaseClient.pool.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ConnectionDiscoveryUsageError) {
    console.error(error.message);
  } else {
    console.error('Connection discovery failed.');
  }
  process.exitCode = 1;
}
