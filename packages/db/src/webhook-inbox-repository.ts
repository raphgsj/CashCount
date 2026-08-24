import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type { Pool, PoolClient } from 'pg';

import type { PayloadEncryptionService } from './encryption.js';

const webhookCapabilityBrand: unique symbol = Symbol('cashcount.authenticated-webhook-ingestion');

export interface AuthenticatedWebhookIngestionCapability {
  readonly [webhookCapabilityBrand]: true;
}

export const authenticatedWebhookIngestionCapability: AuthenticatedWebhookIngestionCapability =
  Object.freeze({ [webhookCapabilityBrand]: true as const });

export interface PluggyWebhookInboxInput {
  eventType: string;
  externalAccountId: null | string;
  externalConnectionId: string;
  externalEventId: string;
  payload: unknown;
  receivedAt: Date;
}

export interface PluggyWebhookInboxResult {
  duplicate: boolean;
  mapped: boolean;
}

interface WorkspaceMappingRow {
  workspace_id: string;
}

interface InsertedWebhookRow {
  id: string;
}

async function resolveWorkspace(
  client: PoolClient,
  externalConnectionId: string,
  externalAccountId: null | string,
): Promise<null | string> {
  const result =
    externalAccountId === null
      ? await client.query<WorkspaceMappingRow>(
          `select workspace_id
           from provider_connection
           where provider = 'PLUGGY' and external_connection_id = $1
           order by workspace_id
           limit 2`,
          [externalConnectionId],
        )
      : await client.query<WorkspaceMappingRow>(
          `select pc.workspace_id
           from provider_connection pc
           join financial_account fa
             on fa.workspace_id = pc.workspace_id
            and fa.provider_connection_id = pc.id
            and fa.provider = 'PLUGGY'
            and fa.external_account_id = $2
           where pc.provider = 'PLUGGY' and pc.external_connection_id = $1
           order by pc.workspace_id
           limit 2`,
          [externalConnectionId, externalAccountId],
        );

  return result.rows.length === 1 ? (result.rows[0]?.workspace_id ?? null) : null;
}

export class WebhookInboxRepository {
  public constructor(
    private readonly pool: Pool,
    private readonly encryption: PayloadEncryptionService,
  ) {}

  public async ingestAuthenticatedPluggyWebhook(
    capability: AuthenticatedWebhookIngestionCapability,
    input: PluggyWebhookInboxInput,
  ): Promise<PluggyWebhookInboxResult> {
    if (capability !== authenticatedWebhookIngestionCapability) {
      throw new TypeError('Authenticated webhook ingestion capability is required.');
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const workspaceId = await resolveWorkspace(
        client,
        input.externalConnectionId,
        input.externalAccountId,
      );
      const recordId = randomUUID();
      const envelope = this.encryption.encryptJson(input.payload, {
        entityType: input.eventType,
        externalId: input.externalEventId,
        provider: 'PLUGGY',
        recordId,
        storageTable: 'webhook_event',
        workspaceId,
      });
      const inserted = await client.query<InsertedWebhookRow>(
        `insert into webhook_event (
           id, workspace_id, provider, external_event_id, event_type,
           external_connection_id, external_account_id,
           payload_ciphertext, payload_iv, payload_tag, key_version,
           payload_sha256, canonicalization_version, received_at, status
         ) values (
           $1::uuid, $2::uuid, 'PLUGGY', $3, $4, $5, $6,
           $7::bytea, $8::bytea, $9::bytea, $10,
           $11, $12, $13::timestamptz, $14
         )
         on conflict do nothing
         returning id`,
        [
          recordId,
          workspaceId,
          input.externalEventId,
          input.eventType,
          input.externalConnectionId,
          input.externalAccountId,
          Buffer.from(envelope.ciphertext),
          Buffer.from(envelope.nonce),
          Buffer.from(envelope.authenticationTag),
          envelope.keyVersion,
          envelope.payloadSha256,
          envelope.canonicalizationVersion,
          input.receivedAt,
          workspaceId === null ? 'UNMAPPED' : 'QUEUED',
        ],
      );

      const webhook = inserted.rows[0];
      if (webhook === undefined) {
        await client.query('commit');
        return { duplicate: true, mapped: workspaceId !== null };
      }

      await client.query(
        `insert into job_queue (
           workspace_id, job_type, payload, dedupe_key, max_attempts
         ) values (
           $1::uuid, 'PROCESS_WEBHOOK', jsonb_build_object('webhookEventId', $2::text), $3, 8
         )`,
        [workspaceId, webhook.id, `webhook-event:${webhook.id}`],
      );
      await client.query('commit');
      return { duplicate: false, mapped: workspaceId !== null };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
