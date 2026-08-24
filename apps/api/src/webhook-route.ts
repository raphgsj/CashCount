import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';

import {
  authenticatedWebhookIngestionCapability,
  type PluggyWebhookInboxInput,
  type PluggyWebhookInboxResult,
} from '@cashcount/db/webhook';

import { pluggyWebhookPayloadSchema, type PluggyWebhookPayload } from './pluggy-webhook-schema.js';
import { requirePluggyWebhookCredential } from './webhook-auth.js';
import type { SyncOperationalRouteDependencies } from './sync-operational-route.js';

export const pluggyWebhookBodyLimitBytes = 256 * 1_024;

export interface WebhookInboxWriter {
  ingestAuthenticatedPluggyWebhook(
    capability: typeof authenticatedWebhookIngestionCapability,
    input: PluggyWebhookInboxInput,
  ): Promise<PluggyWebhookInboxResult>;
}

export interface PluggyWebhookRouteDependencies {
  bodyLimitBytes?: number;
  inbox: WebhookInboxWriter;
  now?: () => Date;
  webhookSecret: string;
  operational?: SyncOperationalRouteDependencies;
}

export interface WebhookRouteResult {
  body: Readonly<Record<string, boolean | string>>;
  status: number;
}

class BodyLimitError extends Error {}

function payloadAccountId(payload: PluggyWebhookPayload): null | string {
  return 'accountId' in payload && typeof payload.accountId === 'string' ? payload.accountId : null;
}

export async function processPluggyWebhookBody(
  authorizationHeader: null | string,
  body: Uint8Array,
  dependencies: PluggyWebhookRouteDependencies,
): Promise<WebhookRouteResult> {
  if (!requirePluggyWebhookCredential(authorizationHeader, dependencies.webhookSecret)) {
    return { body: { error: 'UNAUTHORIZED' }, status: 401 };
  }

  const bodyLimitBytes = dependencies.bodyLimitBytes ?? pluggyWebhookBodyLimitBytes;
  if (body.byteLength > bodyLimitBytes) {
    return { body: { error: 'PAYLOAD_TOO_LARGE' }, status: 413 };
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { body: { error: 'INVALID_JSON' }, status: 400 };
  }

  const validated = pluggyWebhookPayloadSchema.safeParse(parsed);
  if (!validated.success) {
    return { body: { error: 'INVALID_WEBHOOK' }, status: 400 };
  }

  await dependencies.inbox.ingestAuthenticatedPluggyWebhook(
    authenticatedWebhookIngestionCapability,
    {
      eventType: validated.data.event,
      externalAccountId: payloadAccountId(validated.data),
      externalConnectionId: validated.data.itemId,
      externalEventId: validated.data.eventId,
      payload: parsed,
      receivedAt: (dependencies.now ?? (() => new Date()))(),
    },
  );
  return { body: { accepted: true }, status: 202 };
}

export async function readBoundedRequestBody(
  request: IncomingMessage,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let received = 0;

  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
    received += chunk.byteLength;
    if (received > limit) {
      request.resume();
      throw new BodyLimitError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, received);
}
