import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { parseWorkerConfig } from '@cashcount/config';
import {
  AccountImportRepository,
  BillImportRepository,
  createDatabaseClient,
  JobQueueRepository,
  PayloadEncryptionService,
  ProviderConnectionRepository,
  ReconciliationRepository,
  TransactionImportRepository,
  TransactionReplacementRepository,
  WebhookProcessingRepository,
} from '@cashcount/db';
import {
  PluggyApiKeyProvider,
  PluggyAuthenticatedHttpClient,
  PluggyDataClient,
} from '@cashcount/provider-pluggy';

import { runFullImport } from './full-import.js';
import { createManualReconciliationHandler } from './manual-reconciliation-handler.js';
import { PersistentQueueWorker } from './queue-worker.js';
import { createPluggyWebhookHandler } from './webhook-event-handler.js';
import { runUntilTermination } from './worker-process.js';

export const applicationName = '@cashcount/worker' as const;
export const config = parseWorkerConfig(process.env);

const databaseUrl = config.DATABASE_URL ?? config.LOCAL_DATABASE_URL;
if (databaseUrl === undefined) throw new Error('Worker database configuration is unavailable.');

const databaseClient = createDatabaseClient(databaseUrl);
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
const accountPersistence = new AccountImportRepository(databaseClient.database);
const billPersistence = new BillImportRepository(databaseClient.database);
const connectionPersistence = new ProviderConnectionRepository(databaseClient.database);
const replacementDetector = new TransactionReplacementRepository(databaseClient.pool);
const reconciliationPersistence = new ReconciliationRepository(databaseClient.pool);
const transactionPersistence = new TransactionImportRepository(databaseClient.database);
const webhookPersistence = new WebhookProcessingRepository(databaseClient.pool);
const processWebhook = createPluggyWebhookHandler({
  applyConnectionSnapshot: async (workspaceId, providerConnectionId, snapshot) => {
    const assigned = await connectionPersistence.assignDiscoveredConnections(workspaceId, [
      snapshot,
    ]);
    if (assigned.length !== 1 || assigned[0]?.id !== providerConnectionId) {
      throw new Error('Provider Item snapshot resolved outside its webhook mapping.');
    }
  },
  encryption,
  fullImport: async (workspaceId, providerConnectionId) =>
    runFullImport({
      accountPersistence,
      billPersistence,
      encryption,
      provider,
      providerConnectionId,
      replacementDetector,
      transactionPersistence,
      triggerType: 'WEBHOOK',
      workspaceId,
    }),
  provider,
  providerBaseUrl: config.PLUGGY_BASE_URL,
  replacementDetector,
  transactionPersistence,
  webhookPersistence,
});
const reconcileConnection = createManualReconciliationHandler({
  applyConnectionSnapshot: async (workspaceId, providerConnectionId, snapshot) => {
    const assigned = await connectionPersistence.assignDiscoveredConnections(workspaceId, [
      snapshot,
    ]);
    if (assigned.length !== 1 || assigned[0]?.id !== providerConnectionId) {
      throw new Error('Provider Item snapshot resolved outside its manual reconciliation mapping.');
    }
  },
  fullImport: async (workspaceId, providerConnectionId) =>
    runFullImport({
      accountPersistence,
      billPersistence,
      encryption,
      provider,
      providerConnectionId,
      replacementDetector,
      transactionPersistence,
      triggerType: 'MANUAL',
      workspaceId,
    }),
  persistence: reconciliationPersistence,
  provider,
});
const worker = new PersistentQueueWorker({
  handlers: { PROCESS_WEBHOOK: processWebhook, SYNC_CONNECTION: reconcileConnection },
  onOperationalEvent: (event) => console.error(JSON.stringify(event)),
  queue: new JobQueueRepository(databaseClient.pool),
  workerId: `${hostname()}:${process.pid}:${randomUUID()}`,
});

console.log(`${applicationName} started; registered_job_types=2`);
try {
  await runUntilTermination(worker);
} finally {
  await databaseClient.pool.end();
  console.log(`${applicationName} stopped`);
}
