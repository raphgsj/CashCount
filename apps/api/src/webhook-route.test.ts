import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';

import { authenticatedWebhookIngestionCapability } from '@cashcount/db/webhook';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  processPluggyWebhookBody,
  readBoundedRequestBody,
  type PluggyWebhookRouteDependencies,
  type WebhookInboxWriter,
} from './webhook-route.js';

const secret = Buffer.alloc(32, 51).toString('base64url');
const authorization = `Bearer ${secret}`;
const event = {
  event: 'item/updated',
  eventId: '10000000-0000-4000-8000-000000000001',
  itemId: '20000000-0000-4000-8000-000000000001',
  triggeredBy: 'SYNC',
};

function encoded(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function dependencies(
  ingest = vi.fn<WebhookInboxWriter['ingestAuthenticatedPluggyWebhook']>(async () => ({
    duplicate: false,
    mapped: true,
  })),
): PluggyWebhookRouteDependencies & { inbox: { ingestAuthenticatedPluggyWebhook: typeof ingest } } {
  return {
    inbox: { ingestAuthenticatedPluggyWebhook: ingest },
    now: () => new Date('2026-08-23T22:45:00.000Z'),
    webhookSecret: secret,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Pluggy webhook route', () => {
  it('authenticates, validates, normalizes, persists, and accepts without a provider call', async () => {
    const config = dependencies();
    const providerCall = vi.fn();
    vi.stubGlobal('fetch', providerCall);

    const result = await processPluggyWebhookBody(authorization, encoded(event), config);

    expect(result).toEqual({ body: { accepted: true }, status: 202 });
    expect(config.inbox.ingestAuthenticatedPluggyWebhook).toHaveBeenCalledWith(
      authenticatedWebhookIngestionCapability,
      {
        eventType: 'item/updated',
        externalAccountId: null,
        externalConnectionId: event.itemId,
        externalEventId: event.eventId,
        payload: event,
        receivedAt: new Date('2026-08-23T22:45:00.000Z'),
      },
    );
    expect(providerCall).not.toHaveBeenCalled();
  });

  it('returns the same fast 202 for a duplicate inbox result', async () => {
    const config = dependencies(
      vi.fn(async () => ({ duplicate: true as const, mapped: true as const })),
    );
    const startedAt = performance.now();
    const result = await processPluggyWebhookBody(authorization, encoded(event), config);

    expect(result.status).toBe(202);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it('rejects auth, malformed input, unsupported events, and oversized bodies before persistence', async () => {
    const config = dependencies();
    expect(await processPluggyWebhookBody(null, encoded(event), config)).toHaveProperty(
      'status',
      401,
    );
    expect(await processPluggyWebhookBody(authorization, Buffer.from('{'), config)).toHaveProperty(
      'status',
      400,
    );
    expect(
      await processPluggyWebhookBody(
        authorization,
        encoded({ ...event, event: 'payment_intent/created' }),
        config,
      ),
    ).toHaveProperty('status', 400);
    expect(
      await processPluggyWebhookBody(authorization, Buffer.alloc(17), {
        ...config,
        bodyLimitBytes: 16,
      }),
    ).toHaveProperty('status', 413);
    expect(config.inbox.ingestAuthenticatedPluggyWebhook).not.toHaveBeenCalled();
  });

  it('enforces the streaming body limit even without Content-Length', async () => {
    const stream = Readable.from([
      Buffer.alloc(10),
      Buffer.alloc(10),
    ]) as unknown as IncomingMessage;
    await expect(readBoundedRequestBody(stream, 16)).rejects.toThrow();
  });
});
