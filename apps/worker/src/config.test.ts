import { Buffer } from 'node:buffer';

import { parseWorkerConfig } from '@cashcount/config';
import { describe, expect, it } from 'vitest';

function encodedBytes(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64');
}

function validWorkerEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'development',
    LOCAL_DATABASE_URL: 'postgresql://cashcount:cashcount@localhost:5432/cashcount',
    DATA_ENCRYPTION_ACTIVE_KEY_VERSION: '2',
    DATA_ENCRYPTION_KEYRING_JSON: JSON.stringify({
      1: encodedBytes(1),
      2: encodedBytes(2),
    }),
    PLUGGY_CLIENT_ID: 'synthetic-client-id',
    PLUGGY_CLIENT_SECRET: 'synthetic-client-secret',
  };
}

describe('worker environment', () => {
  it('parses a valid local configuration and applies documented defaults', () => {
    const config = parseWorkerConfig(validWorkerEnvironment());

    expect(config.APP_TIMEZONE).toBe('America/Sao_Paulo');
    expect(config.DEFAULT_CURRENCY).toBe('BRL');
    expect(config.PLUGGY_BASE_URL).toBe('https://api.pluggy.ai');
  });

  it('names a missing Pluggy credential', () => {
    const environment = validWorkerEnvironment();
    delete environment['PLUGGY_CLIENT_SECRET'];

    expect(() => parseWorkerConfig(environment)).toThrowError(/PLUGGY_CLIENT_SECRET/);
  });

  it('rejects malformed encryption keys', () => {
    const environment = validWorkerEnvironment();
    environment['DATA_ENCRYPTION_KEYRING_JSON'] = JSON.stringify({ 1: 'not-a-key' });

    expect(() => parseWorkerConfig(environment)).toThrowError(/exactly 32 bytes/);
  });

  it('rejects an active version absent from the keyring', () => {
    const environment = validWorkerEnvironment();
    environment['DATA_ENCRYPTION_ACTIVE_KEY_VERSION'] = '3';

    expect(() => parseWorkerConfig(environment)).toThrowError(/DATA_ENCRYPTION_ACTIVE_KEY_VERSION/);
  });

  it('rejects duplicate encryption key material', () => {
    const environment = validWorkerEnvironment();
    environment['DATA_ENCRYPTION_KEYRING_JSON'] = JSON.stringify({
      1: encodedBytes(1),
      2: encodedBytes(1),
    });

    expect(() => parseWorkerConfig(environment)).toThrowError(/duplicates another encryption key/);
  });

  it('rejects duplicate version properties before JSON parsing can overwrite them', () => {
    const environment = validWorkerEnvironment();
    environment['DATA_ENCRYPTION_KEYRING_JSON'] =
      `{"1":"${encodedBytes(1)}","1":"${encodedBytes(2)}"}`;

    expect(() => parseWorkerConfig(environment)).toThrowError(/duplicate JSON property "1"/);
  });
});
