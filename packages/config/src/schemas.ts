import { z } from 'zod';

import { encryptionKeyringSchema } from './keyring.js';
import {
  booleanStringSchema,
  canonicalUuidSchema,
  currencySchema,
  highEntropyTokenSchema,
  httpUrlSchema,
  logLevelSchema,
  nodeEnvironmentSchema,
  optionalDatabaseUrlSchema,
  optionalHttpUrlSchema,
  positiveIntegerStringSchema,
  rateLimitSchema,
  requiredStringSchema,
  secretStringSchema,
  timeZoneSchema,
} from './primitives.js';
import { parseEnvironment, type EnvironmentInput } from './validation-error.js';

type IssueReporter = (path: string, message: string) => void;

interface DatabaseEnvironment {
  NODE_ENV: 'development' | 'test' | 'production';
  DATABASE_URL?: string | undefined;
  LOCAL_DATABASE_URL?: string | undefined;
}

export interface DatabaseConfig {
  databaseUrl: string;
  nodeEnvironment: DatabaseEnvironment['NODE_ENV'];
}

interface EncryptionEnvironment {
  DATA_ENCRYPTION_ACTIVE_KEY_VERSION: number;
  DATA_ENCRYPTION_KEYRING_JSON: ReadonlyMap<number, Uint8Array>;
}

interface Credential {
  name: string;
  value: string;
}

const runtimeFields = {
  NODE_ENV: nodeEnvironmentSchema,
  LOG_LEVEL: logLevelSchema,
  SENTRY_DSN: optionalHttpUrlSchema,
};

const backendFields = {
  ...runtimeFields,
  APP_TIMEZONE: timeZoneSchema.default('America/Sao_Paulo'),
  DEFAULT_CURRENCY: currencySchema.default('BRL'),
  DATABASE_URL: optionalDatabaseUrlSchema,
  LOCAL_DATABASE_URL: optionalDatabaseUrlSchema,
  DATA_ENCRYPTION_ACTIVE_KEY_VERSION: positiveIntegerStringSchema,
  DATA_ENCRYPTION_KEYRING_JSON: encryptionKeyringSchema,
};

function validateDatabaseEnvironment(
  environment: DatabaseEnvironment,
  report: IssueReporter,
): void {
  if (environment.NODE_ENV === 'production') {
    if (environment.DATABASE_URL === undefined) {
      report('DATABASE_URL', 'is required in production');
    }

    if (environment.LOCAL_DATABASE_URL !== undefined) {
      report('LOCAL_DATABASE_URL', 'is permitted only outside production');
    }

    return;
  }

  if (environment.DATABASE_URL === undefined && environment.LOCAL_DATABASE_URL === undefined) {
    report('DATABASE_URL', 'or LOCAL_DATABASE_URL is required');
  }
}

const databaseEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironmentSchema,
    DATABASE_URL: optionalDatabaseUrlSchema,
    LOCAL_DATABASE_URL: optionalDatabaseUrlSchema,
  })
  .superRefine((environment, context) => {
    validateDatabaseEnvironment(environment, (path, message) => {
      context.addIssue({ code: 'custom', path: [path], message });
    });
  });

function validateEncryptionEnvironment(
  environment: EncryptionEnvironment,
  report: IssueReporter,
): void {
  if (
    !environment.DATA_ENCRYPTION_KEYRING_JSON.has(environment.DATA_ENCRYPTION_ACTIVE_KEY_VERSION)
  ) {
    report('DATA_ENCRYPTION_ACTIVE_KEY_VERSION', 'must exist in DATA_ENCRYPTION_KEYRING_JSON');
  }
}

function validateDistinctCredentials(
  credentials: readonly Credential[],
  report: IssueReporter,
): void {
  const firstCredentialByValue = new Map<string, string>();

  for (const credential of credentials) {
    const firstCredential = firstCredentialByValue.get(credential.value);

    if (firstCredential !== undefined) {
      report(credential.name, `must not reuse ${firstCredential}`);
      continue;
    }

    firstCredentialByValue.set(credential.value, credential.name);
  }
}

export const apiEnvironmentSchema = z
  .object({
    ...backendFields,
    API_WORKSPACE_ID: canonicalUuidSchema,
    PLUGGY_WEBHOOK_SECRET: highEntropyTokenSchema,
    WEB_TO_API_TOKEN: highEntropyTokenSchema,
    MCP_TO_API_READONLY_TOKEN: highEntropyTokenSchema,
    WEB_APP_URL: httpUrlSchema,
    API_PUBLIC_URL: httpUrlSchema,
    API_PRIVATE_URL: httpUrlSchema,
  })
  .superRefine((environment, context) => {
    const report: IssueReporter = (path, message) => {
      context.addIssue({ code: 'custom', path: [path], message });
    };

    validateDatabaseEnvironment(environment, report);
    validateEncryptionEnvironment(environment, report);
    validateDistinctCredentials(
      [
        { name: 'PLUGGY_WEBHOOK_SECRET', value: environment.PLUGGY_WEBHOOK_SECRET },
        { name: 'WEB_TO_API_TOKEN', value: environment.WEB_TO_API_TOKEN },
        { name: 'MCP_TO_API_READONLY_TOKEN', value: environment.MCP_TO_API_READONLY_TOKEN },
      ],
      report,
    );
  });

export const workerEnvironmentSchema = z
  .object({
    ...backendFields,
    PLUGGY_CLIENT_ID: requiredStringSchema,
    PLUGGY_CLIENT_SECRET: secretStringSchema,
    PLUGGY_BASE_URL: httpUrlSchema.default('https://api.pluggy.ai'),
  })
  .superRefine((environment, context) => {
    const report: IssueReporter = (path, message) => {
      context.addIssue({ code: 'custom', path: [path], message });
    };

    validateDatabaseEnvironment(environment, report);
    validateEncryptionEnvironment(environment, report);
  });

export const webEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironmentSchema,
    AUTH_SECRET: highEntropyTokenSchema,
    AUTH_GITHUB_ID: requiredStringSchema,
    AUTH_GITHUB_SECRET: secretStringSchema,
    ALLOWED_USER_EMAIL: z.string().email(),
    FINANCE_API_BASE_URL: httpUrlSchema,
    WEB_TO_API_TOKEN: highEntropyTokenSchema,
    NEXT_PUBLIC_APP_NAME: requiredStringSchema,
    ALLOW_DEV_AUTH_BYPASS: booleanStringSchema,
  })
  .superRefine((environment, context) => {
    if (environment.NODE_ENV === 'production' && environment.ALLOW_DEV_AUTH_BYPASS) {
      context.addIssue({
        code: 'custom',
        path: ['ALLOW_DEV_AUTH_BYPASS'],
        message: 'must be false in production',
      });
    }
  });

export const mcpEnvironmentSchema = z
  .object({
    NODE_ENV: nodeEnvironmentSchema,
    MCP_PUBLIC_URL: httpUrlSchema,
    FINANCE_API_PRIVATE_URL: httpUrlSchema,
    MCP_CLIENT_TO_MCP_TOKEN: highEntropyTokenSchema,
    MCP_TO_API_READONLY_TOKEN: highEntropyTokenSchema,
    MCP_RATE_LIMIT_PER_MINUTE: rateLimitSchema,
  })
  .superRefine((environment, context) => {
    validateDistinctCredentials(
      [
        { name: 'MCP_CLIENT_TO_MCP_TOKEN', value: environment.MCP_CLIENT_TO_MCP_TOKEN },
        { name: 'MCP_TO_API_READONLY_TOKEN', value: environment.MCP_TO_API_READONLY_TOKEN },
      ],
      (path, message) => {
        context.addIssue({ code: 'custom', path: [path], message });
      },
    );
  });

export type ApiConfig = z.output<typeof apiEnvironmentSchema>;
export type WorkerConfig = z.output<typeof workerEnvironmentSchema>;
export type WebConfig = z.output<typeof webEnvironmentSchema>;
export type McpConfig = z.output<typeof mcpEnvironmentSchema>;

export function parseApiConfig(environment: EnvironmentInput): ApiConfig {
  return parseEnvironment('API', apiEnvironmentSchema, environment);
}

export function parseWorkerConfig(environment: EnvironmentInput): WorkerConfig {
  return parseEnvironment('worker', workerEnvironmentSchema, environment);
}

export function parseWebConfig(environment: EnvironmentInput): WebConfig {
  return parseEnvironment('web', webEnvironmentSchema, environment);
}

export function parseMcpConfig(environment: EnvironmentInput): McpConfig {
  return parseEnvironment('MCP', mcpEnvironmentSchema, environment);
}

export function parseDatabaseConfig(environment: EnvironmentInput): DatabaseConfig {
  const parsed = parseEnvironment('database tooling', databaseEnvironmentSchema, environment);
  const databaseUrl = parsed.DATABASE_URL ?? parsed.LOCAL_DATABASE_URL;

  if (databaseUrl === undefined) {
    throw new Error('Database environment validation completed without a database URL.');
  }

  return {
    databaseUrl,
    nodeEnvironment: parsed.NODE_ENV,
  };
}
