import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import {
  authenticatedWebhookIngestionCapability,
  type PluggyWebhookInboxInput,
  type PluggyWebhookInboxResult,
} from '@cashcount/db/webhook';

import { pluggyWebhookPayloadSchema, type PluggyWebhookPayload } from './pluggy-webhook-schema.js';
import { requirePluggyWebhookCredential } from './webhook-auth.js';
import {
  processSyncOperationalRequest,
  type SyncOperationalRouteDependencies,
} from './sync-operational-route.js';

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

function contentLength(request: IncomingMessage): null | number {
  const value = request.headers['content-length'];
  if (value === undefined) return null;
  if (Array.isArray(value) || !/^\d+$/u.test(value)) return Number.NaN;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
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

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(encoded);
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

export function createApiServer(dependencies: PluggyWebhookRouteDependencies): Server {
  const limit = dependencies.bodyLimitBytes ?? pluggyWebhookBodyLimitBytes;
  return createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://cashcount.invalid');
    const path = requestUrl.pathname;
    if (dependencies.operational !== undefined && path.startsWith('/v1/')) {
      const declaredLength = contentLength(request);
      const hasBody =
        request.headers['transfer-encoding'] !== undefined ||
        (declaredLength !== null && !Number.isNaN(declaredLength) && declaredLength > 0);
      try {
        const operational = await processSyncOperationalRequest(
          {
            authorizationHeader: request.headers.authorization ?? null,
            hasBody,
            invalidContentLength: Number.isNaN(declaredLength),
            method: request.method ?? '',
            url: requestUrl,
          },
          dependencies.operational,
        );
        if (operational !== null) {
          request.resume();
          writeJson(response, operational.status, operational.body, operational.headers);
          return;
        }
      } catch {
        request.resume();
        const requestId = randomUUID();
        writeJson(
          response,
          500,
          {
            code: 'INTERNAL_ERROR',
            requestId,
            status: 500,
            title: 'Internal server error',
            type: 'https://cashcount.invalid/problems/internal-error',
          },
          { 'x-request-id': requestId },
        );
        return;
      }
    }
    if (path !== '/webhooks/pluggy') {
      writeJson(response, 404, { error: 'NOT_FOUND' });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      writeJson(response, 405, { error: 'METHOD_NOT_ALLOWED' });
      return;
    }
    if (
      !requirePluggyWebhookCredential(
        request.headers.authorization ?? null,
        dependencies.webhookSecret,
      )
    ) {
      request.resume();
      writeJson(response, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    if (!isJsonContentType(request.headers['content-type'])) {
      request.resume();
      writeJson(response, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
      return;
    }

    const declaredLength = contentLength(request);
    if (Number.isNaN(declaredLength)) {
      request.resume();
      writeJson(response, 400, { error: 'INVALID_CONTENT_LENGTH' });
      return;
    }
    if (declaredLength !== null && declaredLength > limit) {
      request.resume();
      writeJson(response, 413, { error: 'PAYLOAD_TOO_LARGE' });
      return;
    }

    try {
      const body = await readBoundedRequestBody(request, limit);
      const result = await processPluggyWebhookBody(
        request.headers.authorization ?? null,
        body,
        dependencies,
      );
      writeJson(response, result.status, result.body);
    } catch (error) {
      if (error instanceof BodyLimitError) {
        writeJson(response, 413, { error: 'PAYLOAD_TOO_LARGE' });
        return;
      }
      writeJson(response, 500, { error: 'INTERNAL_ERROR' });
    }
  });
}
