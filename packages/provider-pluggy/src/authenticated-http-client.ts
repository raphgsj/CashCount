import {
  PluggyHttpError,
  PluggyTransportError,
  safeLog,
  type PluggyApiKeyProvider,
  type PluggyHttpLogger,
} from './api-key-provider.js';

export interface PluggyAuthenticatedHttpClientOptions {
  apiKeyProvider: PluggyApiKeyProvider;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  logger?: PluggyHttpLogger;
  now?: () => number;
  requestId?: () => string;
}

export class PluggyAuthenticatedHttpClient {
  readonly #apiKeyProvider: PluggyApiKeyProvider;
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;
  readonly #logger: PluggyHttpLogger | undefined;
  readonly #now: () => number;
  readonly #requestId: () => string;

  public constructor(options: PluggyAuthenticatedHttpClientOptions) {
    this.#apiKeyProvider = options.apiKeyProvider;
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
    this.#now = options.now ?? Date.now;
    this.#requestId = options.requestId ?? (() => crypto.randomUUID());
  }

  public async request(path: string, init: RequestInit = {}): Promise<Response> {
    const url = this.#resolvePath(path);
    const headers = new Headers(init.headers);
    if (headers.has('x-api-key') || headers.has('authorization')) {
      throw new TypeError('Authentication headers are managed by the Pluggy client.');
    }

    const requestId = this.#requestId();
    const method = (init.method ?? 'GET').toUpperCase();
    const firstApiKey = await this.#apiKeyProvider.getApiKey();
    const firstResponse = await this.#attempt({
      apiKey: firstApiKey,
      attempt: 1,
      headers,
      init,
      method,
      requestId,
      url,
    });

    if (firstResponse.status !== 401) {
      if (!firstResponse.ok) {
        throw new PluggyHttpError(method, url.pathname, firstResponse.status);
      }
      return firstResponse;
    }

    this.#apiKeyProvider.invalidate(firstApiKey);
    const refreshedApiKey = await this.#apiKeyProvider.getApiKey();
    const secondResponse = await this.#attempt({
      apiKey: refreshedApiKey,
      attempt: 2,
      headers,
      init,
      method,
      requestId,
      url,
    });
    if (!secondResponse.ok) {
      throw new PluggyHttpError(method, url.pathname, secondResponse.status);
    }

    return secondResponse;
  }

  async #attempt(input: {
    apiKey: string;
    attempt: 1 | 2;
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

    try {
      response = await this.#fetch(input.url, {
        ...input.init,
        headers,
        method: input.method,
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
