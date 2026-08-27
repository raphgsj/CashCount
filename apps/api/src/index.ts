import { parseApiConfig } from '@cashcount/config';
import {
  createWebhookDatabasePool,
  PayloadEncryptionService,
  WebhookInboxRepository,
} from '@cashcount/db/webhook';
import { SyncOperationalRepository } from '@cashcount/db/operational';
import { AccountCardRepository, TransactionApiRepository } from '@cashcount/db/finance';

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
  inbox: new WebhookInboxRepository(pool, encryption),
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
