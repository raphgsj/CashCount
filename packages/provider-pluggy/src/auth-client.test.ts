import { describe, expect, it, vi } from 'vitest';

import {
  PluggyApiKeyProvider,
  PluggyAuthResponseError,
  PluggyAuthenticatedHttpClient,
  type PluggyHttpLogEvent,
  type PluggyHttpLogger,
} from './index.js';

const clientId = 'synthetic-client-id';
const clientSecret = 'synthetic-client-secret';
const firstToken = 'synthetic-api-key-one';
const secondToken = 'synthetic-api-key-two';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
    status,
  });
}

function authProvider(options: {
  fetchImpl: typeof fetch;
  logger?: PluggyHttpLogger;
  now?: () => number;
}): PluggyApiKeyProvider {
  return new PluggyApiKeyProvider({
    baseUrl: 'https://api.pluggy.ai',
    clientId,
    clientSecret,
    fetchImpl: options.fetchImpl,
    requestId: () => 'auth-request-id',
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

describe('PluggyApiKeyProvider', () => {
  it('creates an API key with the documented auth request and caches it', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ accessToken: firstToken }));
    const provider = authProvider({ fetchImpl });

    await expect(provider.getApiKey()).resolves.toBe(firstToken);
    await expect(provider.getApiKey()).resolves.toBe(firstToken);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [request, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(request)).toBe('https://api.pluggy.ai/auth');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ clientId, clientSecret });
  });

  it('refreshes when fewer than five minutes remain', async () => {
    let now = 1_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ accessToken: firstToken }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: secondToken }));
    const provider = authProvider({ fetchImpl, now: () => now });

    await expect(provider.getApiKey()).resolves.toBe(firstToken);
    now += 2 * 60 * 60 * 1_000 - 5 * 60 * 1_000;
    await expect(provider.getApiKey()).resolves.toBe(secondToken);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one in-process refresh across concurrent callers', async () => {
    const pending = Promise.withResolvers<Response>();
    const fetchImpl = vi.fn<typeof fetch>().mockReturnValue(pending.promise);
    const provider = authProvider({ fetchImpl });

    const requests = [provider.getApiKey(), provider.getApiKey(), provider.getApiKey()];
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    pending.resolve(jsonResponse({ accessToken: firstToken }));

    await expect(Promise.all(requests)).resolves.toEqual([firstToken, firstToken, firstToken]);
  });

  it('rejects malformed auth responses and never caches them', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ token: 'invented-field' }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: firstToken }));
    const provider = authProvider({ fetchImpl });

    await expect(provider.getApiKey()).rejects.toBeInstanceOf(PluggyAuthResponseError);
    await expect(provider.getApiKey()).resolves.toBe(firstToken);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('PluggyAuthenticatedHttpClient', () => {
  it('uses x-api-key and refreshes exactly once after a 401', async () => {
    const authFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ accessToken: firstToken }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: secondToken }));
    const dataFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 401 }, 401))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const provider = authProvider({ fetchImpl: authFetch });
    const client = new PluggyAuthenticatedHttpClient({
      apiKeyProvider: provider,
      baseUrl: 'https://api.pluggy.ai',
      fetchImpl: dataFetch,
      requestId: () => 'data-request-id',
    });

    await expect(client.request('/items?cursor=opaque')).resolves.toBeInstanceOf(Response);

    expect(authFetch).toHaveBeenCalledTimes(2);
    expect(dataFetch).toHaveBeenCalledTimes(2);
    expect(new Headers(dataFetch.mock.calls[0]?.[1]?.headers).get('x-api-key')).toBe(firstToken);
    expect(new Headers(dataFetch.mock.calls[1]?.[1]?.headers).get('x-api-key')).toBe(secondToken);
  });

  it('does not retry a second 401', async () => {
    const authFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ accessToken: firstToken }))
      .mockResolvedValueOnce(jsonResponse({ accessToken: secondToken }));
    const dataFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ code: 401 }, 401));
    const client = new PluggyAuthenticatedHttpClient({
      apiKeyProvider: authProvider({ fetchImpl: authFetch }),
      baseUrl: 'https://api.pluggy.ai',
      fetchImpl: dataFetch,
    });

    await expect(client.request('/items')).rejects.toMatchObject({
      status: 401,
    });
    expect(dataFetch).toHaveBeenCalledTimes(2);
    expect(authFetch).toHaveBeenCalledTimes(2);
  });

  it('prevents caller-controlled authentication and cross-origin targets', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ accessToken: firstToken }));
    const client = new PluggyAuthenticatedHttpClient({
      apiKeyProvider: authProvider({ fetchImpl }),
      baseUrl: 'https://api.pluggy.ai',
      fetchImpl,
    });

    await expect(
      client.request('/items', { headers: { authorization: 'Bearer caller-value' } }),
    ).rejects.toThrow(/managed by the Pluggy client/u);
    await expect(client.request('https://example.com/items')).rejects.toThrow(/root-relative/u);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('logs only bounded metadata and omits all auth material and query strings', async () => {
    const events: PluggyHttpLogEvent[] = [];
    const logger: PluggyHttpLogger = { log: (event) => events.push(event) };
    const authFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ accessToken: firstToken }));
    const dataFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const provider = authProvider({ fetchImpl: authFetch, logger });
    const client = new PluggyAuthenticatedHttpClient({
      apiKeyProvider: provider,
      baseUrl: 'https://api.pluggy.ai',
      fetchImpl: dataFetch,
      logger,
      requestId: () => 'data-request-id',
    });

    await client.request('/items?accountId=synthetic-sensitive-id');

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      attempt: 1,
      method: 'GET',
      outcome: 'SUCCESS',
      pathname: '/items',
      requestId: 'data-request-id',
      status: 200,
    });
    const serialized = JSON.stringify(events);
    for (const sensitive of [clientId, clientSecret, firstToken, 'synthetic-sensitive-id']) {
      expect(serialized).not.toContain(sensitive);
    }
    expect(serialized).not.toMatch(/authorization|x-api-key|header|body/iu);
  });

  it('ignores logger failures without duplicating provider requests', async () => {
    const authFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ accessToken: firstToken }));
    const dataFetch = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const logger: PluggyHttpLogger = {
      log: () => {
        throw new Error('synthetic logger failure');
      },
    };
    const client = new PluggyAuthenticatedHttpClient({
      apiKeyProvider: authProvider({ fetchImpl: authFetch, logger }),
      baseUrl: 'https://api.pluggy.ai',
      fetchImpl: dataFetch,
      logger,
    });

    await expect(client.request('/items')).resolves.toBeInstanceOf(Response);
    expect(authFetch).toHaveBeenCalledTimes(1);
    expect(dataFetch).toHaveBeenCalledTimes(1);
  });
});
