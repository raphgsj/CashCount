import { Buffer } from 'node:buffer';

import { z } from 'zod';

const MAX_DATABASE_KEY_VERSION = 2_147_483_647;

function emptyStringToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function decodedTokenByteLength(value: string): number | undefined {
  if (/^(?:[0-9a-fA-F]{2})+$/.test(value)) {
    return value.length / 2;
  }

  try {
    const base64 = Buffer.from(value, 'base64');

    if (base64.toString('base64') === value) {
      return base64.byteLength;
    }

    const base64url = Buffer.from(value, 'base64url');

    if (base64url.toString('base64url') === value) {
      return base64url.byteLength;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export const nodeEnvironmentSchema = z
  .enum(['development', 'test', 'production'])
  .default('development');

export const logLevelSchema = z
  .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
  .default('info');

export const requiredStringSchema = z.string().trim().min(1, 'is required');

export const secretStringSchema = z
  .string()
  .min(1, 'is required')
  .refine((value) => value.trim() === value, 'must not start or end with whitespace');

export const highEntropyTokenSchema = secretStringSchema.refine(
  (value) => (decodedTokenByteLength(value) ?? 0) >= 32,
  'must be canonical hex, Base64, or Base64url encoding of at least 32 bytes',
);

export const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'must use HTTP or HTTPS',
  });

export const optionalHttpUrlSchema = z.preprocess(emptyStringToUndefined, httpUrlSchema.optional());

export const databaseUrlSchema = z
  .string()
  .url()
  .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
    message: 'must use the postgres or postgresql scheme',
  });

export const optionalDatabaseUrlSchema = z.preprocess(
  emptyStringToUndefined,
  databaseUrlSchema.optional(),
);

export const timeZoneSchema = z
  .string()
  .min(1, 'is required')
  .refine(isValidTimeZone, 'must be a valid IANA time zone');

export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be a three-letter uppercase currency code');

export const booleanStringSchema = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const positiveIntegerStringSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a canonical positive integer')
  .transform(Number)
  .refine(
    (value) => Number.isSafeInteger(value) && value <= MAX_DATABASE_KEY_VERSION,
    `must be at most ${MAX_DATABASE_KEY_VERSION}`,
  );

export const rateLimitSchema = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive integer')
  .transform(Number)
  .refine((value) => Number.isSafeInteger(value) && value <= 10_000, {
    message: 'must be at most 10000',
  });
