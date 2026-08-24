import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { isLosslessNumber, parse as parseLosslessJson } from 'lossless-json';

export const payloadCanonicalizationVersion = 'CASHCOUNT_JSON_V1' as const;

const encryptionAlgorithm = 'aes-256-gcm';
const encryptionKeyBytes = 32;
const nonceBytes = 12;
const authenticationTagBytes = 16;
const maxCanonicalNumberLength = 10_000;

export interface PayloadEncryptionContext {
  entityType: string;
  externalId: string;
  provider: string;
  recordId: string;
  storageTable: 'provider_raw_object' | 'webhook_event';
  workspaceId: null | string;
}

export interface EncryptedPayloadEnvelope {
  authenticationTag: Uint8Array;
  canonicalizationVersion: typeof payloadCanonicalizationVersion;
  ciphertext: Uint8Array;
  keyVersion: number;
  nonce: Uint8Array;
  payloadSha256: string;
}

export interface PayloadEncryptionServiceOptions {
  activeKeyVersion: number;
  keyring: ReadonlyMap<number, Uint8Array>;
  randomBytes?: (size: number) => Uint8Array;
}

export class EncryptionConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'EncryptionConfigurationError';
  }
}

export class PayloadAuthenticationError extends Error {
  public constructor() {
    super('Encrypted payload authentication failed.');
    this.name = 'PayloadAuthenticationError';
  }
}

export class MissingEncryptionKeyError extends Error {
  public constructor(public readonly keyVersion: number) {
    super(`Encryption key version ${keyVersion} is not available.`);
    this.name = 'MissingEncryptionKeyError';
  }
}

export class EncryptionKeyRetirementError extends Error {
  public constructor(
    public readonly keyVersion: number,
    reason: string,
  ) {
    super(`Encryption key version ${keyVersion} cannot be retired: ${reason}.`);
    this.name = 'EncryptionKeyRetirementError';
  }
}

function normalizeExactNumber(token: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(token);
  if (match === null) {
    throw new TypeError('Canonical JSON accepts only valid JSON numbers.');
  }

  const negative = match[1] === '-';
  const integer = match[2] ?? '';
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? '0');
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > maxCanonicalNumberLength) {
    throw new TypeError('JSON number exponent is outside the canonicalization limit.');
  }

  const digits = integer + fraction;
  const decimalIndex = integer.length + exponent;
  let expanded: string;
  if (decimalIndex <= 0) {
    expanded = `0.${'0'.repeat(-decimalIndex)}${digits}`;
  } else if (decimalIndex >= digits.length) {
    expanded = `${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
  }

  const [rawWhole = '0', rawFraction = ''] = expanded.split('.');
  const whole = rawWhole.replace(/^0+(?=\d)/u, '');
  const normalizedFraction = rawFraction.replace(/0+$/u, '');
  const magnitude = normalizedFraction.length === 0 ? whole : `${whole}.${normalizedFraction}`;
  if (magnitude.length > maxCanonicalNumberLength) {
    throw new TypeError('JSON number is outside the canonicalization limit.');
  }
  return negative && magnitude !== '0' ? `-${magnitude}` : magnitude;
}

function canonicalizeNumberToken(token: string): string {
  const exact = normalizeExactNumber(token);
  const asNumber = Number(token);
  if (Number.isFinite(asNumber)) {
    const native = JSON.stringify(asNumber);
    if (normalizeExactNumber(native) === exact) {
      return native;
    }
  }
  return exact;
}

function canonicalizeValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers.');
    return JSON.stringify(value);
  }
  if (isLosslessNumber(value)) return canonicalizeNumberToken(value.toString());
  if (typeof value !== 'object') {
    throw new TypeError('Canonical JSON rejects undefined, functions, symbols, and bigints.');
  }
  if (ancestors.has(value)) throw new TypeError('Canonical JSON rejects cyclic values.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) {
        throw new TypeError('Canonical JSON rejects sparse arrays and custom array properties.');
      }
      return `[${value.map((entry) => canonicalizeValue(entry, ancestors)).join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON accepts only plain objects and arrays.');
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const properties = keys.map(
      (key) => `${JSON.stringify(key)}:${canonicalizeValue(record[key], ancestors)}`,
    );
    return `{${properties.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value: unknown): string {
  return canonicalizeValue(value, new Set());
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value), 'utf8').digest('hex');
}

function requireBoundedContextValue(name: string, value: string): void {
  if (value.trim().length === 0 || value.length > 500) {
    throw new TypeError(`Encryption context ${name} must contain 1 to 500 characters.`);
  }
}

function validateContext(context: PayloadEncryptionContext): void {
  requireBoundedContextValue('entityType', context.entityType);
  requireBoundedContextValue('externalId', context.externalId);
  requireBoundedContextValue('provider', context.provider);
  requireBoundedContextValue('recordId', context.recordId);
  if (context.workspaceId !== null) requireBoundedContextValue('workspaceId', context.workspaceId);
}

function authenticatedData(context: PayloadEncryptionContext, keyVersion: number): Buffer {
  validateContext(context);
  return Buffer.from(
    canonicalizeJson({
      canonicalizationVersion: payloadCanonicalizationVersion,
      entityType: context.entityType,
      externalId: context.externalId,
      keyVersion,
      provider: context.provider,
      recordId: context.recordId,
      storageTable: context.storageTable,
      workspaceId: context.workspaceId,
    }),
    'utf8',
  );
}

function validateVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version <= 0 || version > 2_147_483_647) {
    throw new EncryptionConfigurationError('Encryption key versions must be positive integers.');
  }
}

function payloadHash(canonicalPayload: string): string {
  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

export class PayloadEncryptionService {
  readonly #activeKeyVersion: number;
  readonly #keyring = new Map<number, Buffer>();
  readonly #randomBytes: (size: number) => Uint8Array;

  public constructor(options: PayloadEncryptionServiceOptions) {
    validateVersion(options.activeKeyVersion);
    for (const [version, key] of options.keyring) {
      validateVersion(version);
      if (key.byteLength !== encryptionKeyBytes) {
        throw new EncryptionConfigurationError(
          `Encryption key version ${version} must contain exactly 32 bytes.`,
        );
      }
      this.#keyring.set(version, Buffer.from(key));
    }
    if (!this.#keyring.has(options.activeKeyVersion)) {
      throw new EncryptionConfigurationError('The active encryption key version is unavailable.');
    }
    this.#activeKeyVersion = options.activeKeyVersion;
    this.#randomBytes = options.randomBytes ?? randomBytes;
  }

  public get activeKeyVersion(): number {
    return this.#activeKeyVersion;
  }

  public encryptJson(
    payload: unknown,
    context: PayloadEncryptionContext,
  ): EncryptedPayloadEnvelope {
    return this.#encryptCanonicalPayload(canonicalizeJson(payload), context);
  }

  public decryptCanonicalJson(
    envelope: EncryptedPayloadEnvelope,
    context: PayloadEncryptionContext,
  ): string {
    if (envelope.canonicalizationVersion !== payloadCanonicalizationVersion) {
      throw new PayloadAuthenticationError();
    }
    const key = this.#keyring.get(envelope.keyVersion);
    if (key === undefined) throw new MissingEncryptionKeyError(envelope.keyVersion);
    if (
      envelope.nonce.byteLength !== nonceBytes ||
      envelope.authenticationTag.byteLength !== authenticationTagBytes ||
      envelope.ciphertext.byteLength === 0
    ) {
      throw new PayloadAuthenticationError();
    }

    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(encryptionAlgorithm, key, envelope.nonce, {
        authTagLength: authenticationTagBytes,
      });
      decipher.setAAD(authenticatedData(context, envelope.keyVersion));
      decipher.setAuthTag(envelope.authenticationTag);
      plaintext = Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
    } catch {
      throw new PayloadAuthenticationError();
    }

    if (!/^[0-9a-f]{64}$/u.test(envelope.payloadSha256)) {
      throw new PayloadAuthenticationError();
    }
    const expectedHash = Buffer.from(envelope.payloadSha256, 'hex');
    const actualHash = Buffer.from(payloadHash(plaintext.toString('utf8')), 'hex');
    if (!timingSafeEqual(expectedHash, actualHash)) throw new PayloadAuthenticationError();
    return plaintext.toString('utf8');
  }

  public decryptJson(
    envelope: EncryptedPayloadEnvelope,
    context: PayloadEncryptionContext,
  ): unknown {
    try {
      return parseLosslessJson(this.decryptCanonicalJson(envelope, context));
    } catch (error) {
      if (
        error instanceof MissingEncryptionKeyError ||
        error instanceof PayloadAuthenticationError
      ) {
        throw error;
      }
      throw new PayloadAuthenticationError();
    }
  }

  public reencryptJson(
    envelope: EncryptedPayloadEnvelope,
    context: PayloadEncryptionContext,
  ): EncryptedPayloadEnvelope {
    const canonicalPayload = this.decryptCanonicalJson(envelope, context);
    if (envelope.keyVersion === this.#activeKeyVersion) return envelope;
    return this.#encryptCanonicalPayload(canonicalPayload, context);
  }

  public assertReferencedKeyVersionsAvailable(keyVersions: Iterable<number>): void {
    for (const version of keyVersions) {
      if (!this.#keyring.has(version)) throw new MissingEncryptionKeyError(version);
    }
  }

  public assertCanRetireKey(keyVersion: number, referencedKeyVersions: Iterable<number>): void {
    validateVersion(keyVersion);
    if (keyVersion === this.#activeKeyVersion) {
      throw new EncryptionKeyRetirementError(keyVersion, 'it is the active write key');
    }
    for (const referencedVersion of referencedKeyVersions) {
      if (referencedVersion === keyVersion) {
        throw new EncryptionKeyRetirementError(keyVersion, 'encrypted rows still reference it');
      }
    }
  }

  #encryptCanonicalPayload(
    canonicalPayload: string,
    context: PayloadEncryptionContext,
  ): EncryptedPayloadEnvelope {
    const key = this.#keyring.get(this.#activeKeyVersion);
    if (key === undefined) {
      throw new EncryptionConfigurationError('The active encryption key version is unavailable.');
    }
    const nonce = Buffer.from(this.#randomBytes(nonceBytes));
    if (nonce.byteLength !== nonceBytes) {
      throw new EncryptionConfigurationError('The nonce generator returned an invalid length.');
    }
    const cipher = createCipheriv(encryptionAlgorithm, key, nonce, {
      authTagLength: authenticationTagBytes,
    });
    cipher.setAAD(authenticatedData(context, this.#activeKeyVersion));
    const ciphertext = Buffer.concat([cipher.update(canonicalPayload, 'utf8'), cipher.final()]);
    return {
      authenticationTag: Uint8Array.from(cipher.getAuthTag()),
      canonicalizationVersion: payloadCanonicalizationVersion,
      ciphertext: Uint8Array.from(ciphertext),
      keyVersion: this.#activeKeyVersion,
      nonce: Uint8Array.from(nonce),
      payloadSha256: payloadHash(canonicalPayload),
    };
  }
}
