import { describe, expect, it } from 'vitest';

import { parseDatabaseConfig } from './schemas.js';
import { EnvironmentValidationError } from './validation-error.js';

const localDatabaseUrl = 'postgresql://cashcount:cashcount-local@127.0.0.1:5432/cashcount';
const deployedDatabaseUrl = 'postgresql://cashcount:deployed@example.internal:5432/cashcount';

describe('database tooling environment', () => {
  it('uses the local URL outside production', () => {
    expect(parseDatabaseConfig({ LOCAL_DATABASE_URL: localDatabaseUrl })).toEqual({
      databaseUrl: localDatabaseUrl,
      nodeEnvironment: 'development',
    });
  });

  it('prefers DATABASE_URL when both non-production URLs are present', () => {
    expect(
      parseDatabaseConfig({
        NODE_ENV: 'test',
        DATABASE_URL: deployedDatabaseUrl,
        LOCAL_DATABASE_URL: localDatabaseUrl,
      }),
    ).toEqual({
      databaseUrl: deployedDatabaseUrl,
      nodeEnvironment: 'test',
    });
  });

  it('requires DATABASE_URL and rejects the local fallback in production', () => {
    expect(() =>
      parseDatabaseConfig({
        NODE_ENV: 'production',
        LOCAL_DATABASE_URL: localDatabaseUrl,
      }),
    ).toThrow(EnvironmentValidationError);
  });

  it('requires one database URL outside production', () => {
    expect(() => parseDatabaseConfig({ NODE_ENV: 'test' })).toThrow(EnvironmentValidationError);
  });
});
