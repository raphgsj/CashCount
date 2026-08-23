import { Buffer } from 'node:buffer';

import { parseWebConfig } from '@cashcount/config';
import { describe, expect, it } from 'vitest';

function encodedBytes(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64');
}

function validWebEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    AUTH_SECRET: encodedBytes(1),
    AUTH_GITHUB_ID: 'synthetic-github-client-id',
    AUTH_GITHUB_SECRET: 'synthetic-github-client-secret',
    ALLOWED_USER_EMAIL: 'owner@example.com',
    FINANCE_API_BASE_URL: 'https://api.cashcount.example',
    WEB_TO_API_TOKEN: encodedBytes(2),
    NEXT_PUBLIC_APP_NAME: 'CashCount',
    ALLOW_DEV_AUTH_BYPASS: 'false',
  };
}

describe('web environment', () => {
  it('parses a valid production configuration', () => {
    const config = parseWebConfig(validWebEnvironment());

    expect(config.ALLOW_DEV_AUTH_BYPASS).toBe(false);
    expect(config.NEXT_PUBLIC_APP_NAME).toBe('CashCount');
  });

  it('names a missing authentication secret', () => {
    const environment = validWebEnvironment();
    delete environment['AUTH_SECRET'];

    expect(() => parseWebConfig(environment)).toThrowError(/AUTH_SECRET/);
  });

  it('rejects the development authentication bypass in production', () => {
    const environment = validWebEnvironment();
    environment['ALLOW_DEV_AUTH_BYPASS'] = 'true';

    expect(() => parseWebConfig(environment)).toThrowError(/must be false in production/);
  });

  it('rejects a short web-to-API credential', () => {
    const environment = validWebEnvironment();
    environment['WEB_TO_API_TOKEN'] = 'short-token';

    expect(() => parseWebConfig(environment)).toThrowError(/at least 32 bytes/);
  });
});
