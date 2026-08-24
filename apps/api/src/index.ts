import { parseApiConfig } from '@cashcount/config';
import {
  createWebhookDatabasePool,
  PayloadEncryptionService,
  WebhookInboxRepository,
} from '@cashcount/db/webhook';

import { createApiServer } from './webhook-route.js';

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
  inbox: new WebhookInboxRepository(pool, encryption),
  webhookSecret: config.PLUGGY_WEBHOOK_SECRET,
});

server.listen(port);
