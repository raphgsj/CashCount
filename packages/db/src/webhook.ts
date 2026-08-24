import { Pool } from 'pg';

export function createWebhookDatabasePool(connectionString: string): Pool {
  return new Pool({ connectionString });
}

export {
  PayloadEncryptionService,
  payloadCanonicalizationVersion,
  type EncryptedPayloadEnvelope,
  type PayloadEncryptionContext,
  type PayloadEncryptionServiceOptions,
} from './encryption.js';
export { defaultMigrationsFolder, runMigrations } from './migrations.js';
export { seedSyntheticIdentity, syntheticIdentitySeed } from './seed.js';
export {
  authenticatedWebhookIngestionCapability,
  WebhookInboxRepository,
  type AuthenticatedWebhookIngestionCapability,
  type PluggyWebhookInboxInput,
  type PluggyWebhookInboxResult,
} from './webhook-inbox-repository.js';
