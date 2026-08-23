import { Buffer } from 'node:buffer';

import { z } from 'zod';

const MAX_DATABASE_KEY_VERSION = 2_147_483_647;
const JSON_PROPERTY_PATTERN = /"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\])*"(?=\s*:)/gu;

function findDuplicateJsonProperty(raw: string): string | undefined {
  const properties = new Set<string>();

  for (const match of raw.matchAll(JSON_PROPERTY_PATTERN)) {
    const property: unknown = JSON.parse(match[0]);

    if (typeof property !== 'string') {
      continue;
    }

    if (properties.has(property)) {
      return property;
    }

    properties.add(property);
  }

  return undefined;
}

function decodeEncryptionKey(value: string): Uint8Array | undefined {
  try {
    const decoded = Buffer.from(value, 'base64');

    if (decoded.byteLength !== 32 || decoded.toString('base64') !== value) {
      return undefined;
    }

    return Uint8Array.from(decoded);
  } catch {
    return undefined;
  }
}

export const encryptionKeyringSchema = z
  .string()
  .min(1, 'is required')
  .transform((raw, context) => {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      context.addIssue({
        code: 'custom',
        message: 'must be valid JSON',
      });
      return z.NEVER;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      context.addIssue({
        code: 'custom',
        message: 'must be a JSON object keyed by version',
      });
      return z.NEVER;
    }

    const duplicateProperty = findDuplicateJsonProperty(raw);

    if (duplicateProperty !== undefined) {
      context.addIssue({
        code: 'custom',
        message: `contains duplicate JSON property ${JSON.stringify(duplicateProperty)}`,
      });
      return z.NEVER;
    }

    const entries = Object.entries(parsed);

    if (entries.length === 0) {
      context.addIssue({
        code: 'custom',
        message: 'must contain at least one encryption key',
      });
      return z.NEVER;
    }

    const keysByVersion = new Map<number, Uint8Array>();
    const keyMaterial = new Set<string>();
    let isValid = true;

    for (const [version, encodedKey] of entries) {
      const numericVersion = Number(version);

      if (
        !/^[1-9]\d*$/.test(version) ||
        !Number.isSafeInteger(numericVersion) ||
        numericVersion > MAX_DATABASE_KEY_VERSION
      ) {
        context.addIssue({
          code: 'custom',
          message: `contains non-canonical key version ${JSON.stringify(version)}`,
        });
        isValid = false;
        continue;
      }

      if (typeof encodedKey !== 'string') {
        context.addIssue({
          code: 'custom',
          message: `key version ${version} must be a Base64 string`,
        });
        isValid = false;
        continue;
      }

      const decodedKey = decodeEncryptionKey(encodedKey);

      if (decodedKey === undefined) {
        context.addIssue({
          code: 'custom',
          message: `key version ${version} must be canonical Base64 encoding of exactly 32 bytes`,
        });
        isValid = false;
        continue;
      }

      if (keyMaterial.has(encodedKey)) {
        context.addIssue({
          code: 'custom',
          message: `key version ${version} duplicates another encryption key`,
        });
        isValid = false;
        continue;
      }

      keyMaterial.add(encodedKey);
      keysByVersion.set(numericVersion, decodedKey);
    }

    return isValid ? keysByVersion : z.NEVER;
  });
