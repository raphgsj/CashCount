import { parseApiConfig } from '@cashcount/config';
import {
  AnomalyForecastRepository,
  InstallmentCommitmentsRepository,
  SpendingCashFlowAnalyticsRepository,
} from '@cashcount/analytics';
import {
  createWebhookDatabasePool,
  PayloadEncryptionService,
  WebhookInboxRepository,
} from '@cashcount/db/webhook';
import { SyncOperationalRepository } from '@cashcount/db/operational';
import {
  AccountCardRepository,
  BillReconciliationRepository,
  ClassificationManagementRepository,
  RecurringRepository,
  TransactionApiRepository,
} from '@cashcount/db/finance';

import { createApiServer } from './api-server.js';

export const applicationName = '@cashcount/api' as const;
export const config = parseApiConfig(process.env);

const databaseUrl = config.DATABASE_URL ?? config.LOCAL_DATABASE_URL;
if (databaseUrl === undefined) throw new Error('Validated API configuration has no database URL.');
const port = Number(process.env['PORT'] ?? '3000');
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error('PORT must be an integer from 1 to 65535.');
}

const pool = createWebhookDatabasePool(databaseUrl);
const encryption = new PayloadEncryptionService({
  activeKeyVersion: config.DATA_ENCRYPTION_ACTIVE_KEY_VERSION,
  keyring: config.DATA_ENCRYPTION_KEYRING_JSON,
});
const server = createApiServer({
  accountCards: {
    repository: new AccountCardRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  analytics: {
    mcpToken: config.MCP_TO_API_READONLY_TOKEN,
    repository: new SpendingCashFlowAnalyticsRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  anomalyForecast: {
    mcpToken: config.MCP_TO_API_READONLY_TOKEN,
    repository: new AnomalyForecastRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  billReconciliation: {
    mcpToken: config.MCP_TO_API_READONLY_TOKEN,
    repository: new BillReconciliationRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  classificationManagement: {
    actorId: 'service_web',
    repository: new ClassificationManagementRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  inbox: new WebhookInboxRepository(pool, encryption),
  installments: {
    mcpToken: config.MCP_TO_API_READONLY_TOKEN,
    repository: new InstallmentCommitmentsRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  mcpToken: config.MCP_TO_API_READONLY_TOKEN,
  nodeEnvironment: config.NODE_ENV,
  operational: {
    repository: new SyncOperationalRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  readiness: async () => {
    await pool.query('select 1');
    return true;
  },
  recurring: {
    mcpToken: config.MCP_TO_API_READONLY_TOKEN,
    repository: new RecurringRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  transactions: {
    actorId: 'service_web',
    repository: new TransactionApiRepository(pool),
    webToken: config.WEB_TO_API_TOKEN,
    workspaceId: config.API_WORKSPACE_ID,
  },
  webhookSecret: config.PLUGGY_WEBHOOK_SECRET,
  workspaceId: config.API_WORKSPACE_ID,
});

await server.listen({ host: '0.0.0.0', port });
