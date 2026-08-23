import {
  PluggyHttpError,
  PluggyTransportError,
  safeLog,
  type PluggyApiKeyProvider,
  type PluggyHttpLogger,
} from './api-key-provider.js';

export interface PluggyAuthenticatedHttpClientOptions {
  apiKeyProvider: PluggyApiKeyProvider;
  baseRetryDelayMs?: number;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  logger?: PluggyHttpLogger;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  now?: () => number;
  random?: () => number;
  requestId?: () => string;
  sleep?: (delayMs: number) => Promise<void>;
  timeoutMs?: number;
}

export class PluggyAuthenticatedHttpClient {
  readonly #apiKeyProvider: PluggyApiKeyProvider;
  readonly #baseRetryDelayMs: number;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #logger: PluggyHttpLogger | undefined;
  readonly #maxRetries: number;
  readonly #maxRetryDelayMs: number;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #requestId: () => string;
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #timeoutMs: number;

  public constructor(options: PluggyAuthenticatedHttpClientOptions) {
    this.#apiKeyProvider = options.apiKeyProvider;
    this.#baseRetryDelayMs = options.baseRetryDelayMs ?? 250;
    this.#baseUrl = new URL(options.baseUrl);
    if (
      (this.#baseUrl.protocol !== 'https:' && this.#baseUrl.protocol !== 'http:') ||
      this.#baseUrl.username.length > 0 ||
      this.#baseUrl.password.length > 0
    ) {
      throw new TypeError('Pluggy base URL must be an HTTP(S) URL without embedded credentials.');
    }
    this.#fetch = options.fetchImpl ?? fetch;
    this.#logger = options.logger;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#requestId = options.requestId ?? (() => crypto.randomUUID());
    this.#sleep =
      options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.#timeoutMs = options.timeoutMs ?? 15_000;

    for (const [name, value] of [
      ['baseRetryDelayMs', this.#baseRetryDelayMs],
      ['maxRetries', this.#maxRetries],
      ['maxRetryDelayMs', this.#maxRetryDelayMs],
      ['timeoutMs', this.#timeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < (name === 'maxRetries' ? 0 : 1)) {
        throw new RangeError(`${name} must be a valid non-negative retry/timeout setting.`);
      }
    }
  }

  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.#resolvePath(path);
    const headers = new Headers(init.headers);
    if (headers.has('x-api-key') || headers.has('authorization')) {
      throw new TypeError('Authentication headers are managed by the Pluggy client.');
    }

    const requestId = this.#requestId();
    const method = (init.method ?? 'GET').toUpperCase();
    let apiKey = await this.#apiKeyProvider.getApiKey();
    let attempt = 0;
    let authenticationRetried = false;
    let retryCount = 0;

    while (true) {
      attempt += 1;
      const response = await this.#attempt({
        apiKey,
        attempt,
        headers,
        init,
        method,
        requestId,
        url,
      });

      if (response.status === 401 && !authenticationRetried) {
        authenticationRetried = true;
        this.#apiKeyProvider.invalidate(apiKey);
        apiKey = await this.#apiKeyProvider.getApiKey();
        continue;
      }

      if (
        !response.ok &&
        this.#isSafeToRetry(method) &&
        this.#isRetryableStatus(response.status) &&
        retryCount < this.#maxRetries
      ) {
        await this.#sleep(this.#retryDelay(response, retryCount));
        retryCount += 1;
        continue;
      }

      if (!response.ok) {
        throw new PluggyHttpError(method, url.pathname, response.status);
      }
      return response;
    }
  }

  async #attempt(input: {
    apiKey: string;
    attempt: number;
    headers: Headers;
    init: RequestInit;
    method: string;
    requestId: string;
    url: URL;
  }): Promise<Response> {
    const headers = new Headers(input.headers);
    headers.set('accept', headers.get('accept') ?? 'application/json');
    headers.set('x-api-key', input.apiKey);
    const startedAt = this.#now();
    let response: Response;

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), this.#timeoutMs);
    const signal =
      input.init.signal === null || input.init.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([input.init.signal, timeoutController.signal]);

    try {
      response = await this.#fetch(input.url, {
        ...input.init,
        headers,
        method: input.method,
        signal,
      });
    } catch (error) {
      safeLog(this.#logger, {
        attempt: input.attempt,
        component: 'pluggy_http',
        durationMs: Math.max(0, this.#now() - startedAt),
        method: input.method,
        outcome: 'NETWORK_ERROR',
        pathname: input.url.pathname,
        requestId: input.requestId,
        status: null,
      });
      throw new PluggyTransportError({ cause: error });
    } finally {
      clearTimeout(timeout);
    }

    safeLog(this.#logger, {
      attempt: input.attempt,
      component: 'pluggy_http',
      durationMs: Math.max(0, this.#now() - startedAt),
      method: input.method,
      outcome:
        response.status === 401 && input.attempt === 1
          ? 'AUTH_RETRY'
          : response.ok
            ? 'SUCCESS'
            : 'HTTP_ERROR',
      pathname: input.url.pathname,
      requestId: input.requestId,
      status: response.status,
    });
    return response;
  }

  #isRetryableStatus(status: number): boolean {
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  #isSafeToRetry(method: string): boolean {
    return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  }

  #retryDelay(response: Response, retryCount: number): number {
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter !== null) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(Math.round(seconds * 1_000), this.#maxRetryDelayMs);
      }

      const at = Date.parse(retryAfter);
      if (!Number.isNaN(at)) {
        return Math.min(Math.max(0, at - this.#now()), this.#maxRetryDelayMs);
      }
    }

    const ceiling = Math.min(this.#maxRetryDelayMs, this.#baseRetryDelayMs * 2 ** retryCount);
    return Math.max(1, Math.round(ceiling * (0.5 + this.#random() * 0.5)));
  }

  #resolvePath(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//')) {
      throw new TypeError('Pluggy request paths must be root-relative.');
    }

    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#baseUrl.origin) {
      throw new TypeError('Pluggy request path resolved outside the configured origin.');
    }
    return url;
  }
}
