import { z } from 'zod';

const apiKeyLifetimeMs = 2 * 60 * 60 * 1_000;
const defaultRefreshSkewMs = 5 * 60 * 1_000;

const authResponseSchema = z.object({
  accessToken: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0),
});

export type PluggyHttpOutcome = 'AUTH_RETRY' | 'HTTP_ERROR' | 'NETWORK_ERROR' | 'SUCCESS';

/** Deliberately excludes request/response headers, bodies, query strings, and error messages. */
export interface PluggyHttpLogEvent {
  attempt: 1 | 2;
  component: 'pluggy_http';
  durationMs: number;
  method: string;
  outcome: PluggyHttpOutcome;
  pathname: string;
  requestId: string;
  status: number | null;
}

export interface PluggyHttpLogger {
  log(event: PluggyHttpLogEvent): void;
}

export class PluggyHttpError extends Error {
  public constructor(
    public readonly method: string,
    public readonly pathname: string,
    public readonly status: number,
  ) {
    super(`Pluggy request failed with HTTP ${String(status)}.`);
    this.name = 'PluggyHttpError';
  }
}

export class PluggyAuthResponseError extends Error {
  public constructor() {
    super('Pluggy returned an invalid authentication response.');
    this.name = 'PluggyAuthResponseError';
  }
}

export class PluggyTransportError extends Error {
  public constructor(options?: ErrorOptions) {
    super('Pluggy request failed before receiving an HTTP response.', options);
    this.name = 'PluggyTransportError';
  }
}

export interface PluggyApiKeyProviderOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  logger?: PluggyHttpLogger;
  now?: () => number;
  refreshSkewMs?: number;
  requestId?: () => string;
}

interface CachedApiKey {
  expiresAtMs: number;
  value: string;
}

function parseBaseUrl(value: string): URL {
  const url = new URL(value);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new TypeError('Pluggy base URL must be an HTTP(S) URL without embedded credentials.');
  }

  return url;
}

export function safeLog(logger: PluggyHttpLogger | undefined, event: PluggyHttpLogEvent): void {
  try {
    logger?.log(Object.freeze({ ...event }));
  } catch {
    // Telemetry failure must not change financial-data retrieval behavior.
  }
}

export class PluggyApiKeyProvider {
  readonly #authUrl: URL;
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #logger: PluggyHttpLogger | undefined;
  readonly #now: () => number;
  readonly #refreshSkewMs: number;
  readonly #requestId: () => string;

  #cached: CachedApiKey | null = null;
  #refreshPromise: Promise<string> | null = null;

  public constructor(options: PluggyApiKeyProviderOptions) {
    if (options.clientId.trim().length === 0 || options.clientSecret.trim().length === 0) {
      throw new TypeError('Pluggy credentials must be non-empty.');
    }

    if (
      options.refreshSkewMs !== undefined &&
      (!Number.isSafeInteger(options.refreshSkewMs) || options.refreshSkewMs < 0)
    ) {
      throw new RangeError('Pluggy refresh skew must be a non-negative safe integer.');
    }

    this.#authUrl = new URL('/auth', parseBaseUrl(options.baseUrl));
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#refreshSkewMs = options.refreshSkewMs ?? defaultRefreshSkewMs;
    this.#requestId = options.requestId ?? (() => crypto.randomUUID());
  }

  public async getApiKey(): Promise<string> {
    if (this.#cached !== null && this.#cached.expiresAtMs - this.#now() > this.#refreshSkewMs) {
      return this.#cached.value;
    }

    if (this.#refreshPromise === null) {
      this.#refreshPromise = this.#refresh().finally(() => {
        this.#refreshPromise = null;
      });
    }

    return this.#refreshPromise;
  }

  /** Invalidates only the key that failed, avoiding removal of a newer concurrent refresh. */
  public invalidate(apiKey?: string): void {
    if (this.#cached !== null && (apiKey === undefined || this.#cached.value === apiKey)) {
      this.#cached = null;
    }
  }

  async #refresh(): Promise<string> {
    const requestId = this.#requestId();
    const startedAt = this.#now();
    let response: Response;

    try {
      response = await this.#fetch(this.#authUrl, {
        body: JSON.stringify({ clientId: this.#clientId, clientSecret: this.#clientSecret }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        method: 'POST',
      });
    } catch (error) {
      safeLog(this.#logger, {
        attempt: 1,
        component: 'pluggy_http',
        durationMs: Math.max(0, this.#now() - startedAt),
        method: 'POST',
        outcome: 'NETWORK_ERROR',
        pathname: '/auth',
        requestId,
        status: null,
      });
      throw new PluggyTransportError({ cause: error });
    }

    safeLog(this.#logger, {
      attempt: 1,
      component: 'pluggy_http',
      durationMs: Math.max(0, this.#now() - startedAt),
      method: 'POST',
      outcome: response.ok ? 'SUCCESS' : 'HTTP_ERROR',
      pathname: '/auth',
      requestId,
      status: response.status,
    });

    if (!response.ok) {
      throw new PluggyHttpError('POST', '/auth', response.status);
    }

    let parsedBody: unknown;
    try {
      parsedBody = await response.json();
    } catch {
      throw new PluggyAuthResponseError();
    }

    const parsed = authResponseSchema.safeParse(parsedBody);
    if (!parsed.success) {
      throw new PluggyAuthResponseError();
    }

    this.#cached = {
      expiresAtMs: this.#now() + apiKeyLifetimeMs,
      value: parsed.data.accessToken,
    };
    return this.#cached.value;
  }
}
