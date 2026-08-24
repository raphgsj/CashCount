import { Buffer } from 'node:buffer';

import { EnvironmentValidationError, parseApiConfig } from '@cashcount/config';
import { describe, expect, it } from 'vitest';

function encodedBytes(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64');
}

function validApiEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    APP_TIMEZONE: 'America/Sao_Paulo',
    API_WORKSPACE_ID: '10000000-0000-4000-8000-000000000001',
    DEFAULT_CURRENCY: 'BRL',
    DATABASE_URL: 'postgresql://cashcount:cashcount@database.internal:5432/cashcount',
    DATA_ENCRYPTION_ACTIVE_KEY_VERSION: '2',
    DATA_ENCRYPTION_KEYRING_JSON: JSON.stringify({
      1: encodedBytes(1),
      2: encodedBytes(2),
    }),
    PLUGGY_WEBHOOK_SECRET: encodedBytes(3),
    WEB_TO_API_TOKEN: encodedBytes(4),
    MCP_TO_API_READONLY_TOKEN: encodedBytes(5),
    WEB_APP_URL: 'https://cashcount.example',
    API_PUBLIC_URL: 'https://api.cashcount.example',
    API_PRIVATE_URL: 'http://cashcount-api.railway.internal',
    LOG_LEVEL: 'info',
  };
}

describe('API environment', () => {
  it('parses a valid production configuration and decodes the keyring', () => {
    const config = parseApiConfig(validApiEnvironment());

    expect(config.NODE_ENV).toBe('production');
    expect(config.DATA_ENCRYPTION_ACTIVE_KEY_VERSION).toBe(2);
    expect(config.DATA_ENCRYPTION_KEYRING_JSON.get(2)).toHaveLength(32);
    expect(config.API_WORKSPACE_ID).toBe('10000000-0000-4000-8000-000000000001');
  });

  it('names a missing production database variable', () => {
    const environment = validApiEnvironment();
    delete environment['DATABASE_URL'];

    expect(() => parseApiConfig(environment)).toThrowError(/DATABASE_URL/);
  });

  it('rejects a local database URL in production', () => {
    const environment = validApiEnvironment();
    environment['LOCAL_DATABASE_URL'] = environment['DATABASE_URL'];

    expect(() => parseApiConfig(environment)).toThrowError(/LOCAL_DATABASE_URL/);
  });

  it('requires a canonical server-bound API workspace', () => {
    const environment = validApiEnvironment();
    environment['API_WORKSPACE_ID'] = 'caller-selected';

    expect(() => parseApiConfig(environment)).toThrowError(/API_WORKSPACE_ID/u);
  });

  it('rejects trust-boundary credential reuse without exposing the value', () => {
    const environment = validApiEnvironment();
    environment['MCP_TO_API_READONLY_TOKEN'] = environment['WEB_TO_API_TOKEN'];

    try {
      parseApiConfig(environment);
      throw new Error('expected environment validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentValidationError);
      expect((error as Error).message).toContain('MCP_TO_API_READONLY_TOKEN');
      expect((error as Error).message).not.toContain(environment['WEB_TO_API_TOKEN']);
    }
  });
});
