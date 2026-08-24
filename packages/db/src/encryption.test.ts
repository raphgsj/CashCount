import { parse as parseLosslessJson } from 'lossless-json';
import { describe, expect, it } from 'vitest';

import {
  canonicalJsonSha256,
  canonicalizeJson,
  EncryptionConfigurationError,
  EncryptionKeyRetirementError,
  MissingEncryptionKeyError,
  PayloadAuthenticationError,
  PayloadEncryptionService,
  type EncryptedPayloadEnvelope,
  type PayloadEncryptionContext,
} from './encryption.js';

const keyOne = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const keyTwo = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
const context: PayloadEncryptionContext = {
  entityType: 'TRANSACTION',
  externalId: 'synthetic-transaction',
  provider: 'PLUGGY',
  recordId: '11111111-1111-4111-8111-111111111111',
  storageTable: 'provider_raw_object',
  workspaceId: '22222222-2222-4222-8222-222222222222',
};

function service(activeKeyVersion = 1): PayloadEncryptionService {
  return new PayloadEncryptionService({
    activeKeyVersion,
    keyring: new Map([
      [1, keyOne],
      [2, keyTwo],
    ]),
  });
}

function changed(
  envelope: EncryptedPayloadEnvelope,
  patch: Partial<EncryptedPayloadEnvelope>,
): EncryptedPayloadEnvelope {
  return { ...envelope, ...patch };
}

describe('canonical JSON', () => {
  it('sorts object keys recursively and produces a stable SHA-256', () => {
    const first = { z: [3, { b: true, a: null }], a: 'á' };
    const second = { a: 'á', z: [3, { a: null, b: true }] };

    expect(canonicalizeJson(first)).toBe('{"a":"á","z":[3,{"a":null,"b":true}]}');
    expect(canonicalJsonSha256(first)).toBe(canonicalJsonSha256(second));
    expect(canonicalJsonSha256(first)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('retains exact lossless number evidence and normalizes equivalent decimal tokens', () => {
    const first = parseLosslessJson('{"amount":99999999999999.123456,"zero":-0.0}');
    const second = parseLosslessJson('{"zero":0,"amount":99999999999999.1234560}');

    expect(canonicalizeJson(first)).toBe('{"amount":99999999999999.123456,"zero":0}');
    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second));
  });

  it('rejects values outside the canonical JSON data model', () => {
    expect(() => canonicalizeJson({ missing: undefined })).toThrow(TypeError);
    expect(() => canonicalizeJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalizeJson(new Date())).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => canonicalizeJson(cyclic)).toThrow(TypeError);
  });
});

describe('PayloadEncryptionService', () => {
  it('encrypts with the active key and authenticates a lossless round trip', () => {
    const encryption = service(2);
    const payload = parseLosslessJson('{"amount":99999999999999.123456,"label":"synthetic"}');
    const envelope = encryption.encryptJson(payload, context);

    expect(envelope).toMatchObject({ keyVersion: 2 });
    expect(envelope.nonce).toHaveLength(12);
    expect(envelope.authenticationTag).toHaveLength(16);
    expect(envelope.payloadSha256).toBe(canonicalJsonSha256(payload));
    expect(encryption.decryptCanonicalJson(envelope, context)).toBe(canonicalizeJson(payload));
    expect(canonicalizeJson(encryption.decryptJson(envelope, context))).toBe(
      canonicalizeJson(payload),
    );
  });

  it('uses a fresh nonce for every encrypted write', () => {
    const encryption = service();
    const first = encryption.encryptJson({ fixture: true }, context);
    const second = encryption.encryptJson({ fixture: true }, context);

    expect(first.nonce).not.toEqual(second.nonce);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first.payloadSha256).toBe(second.payloadSha256);
  });

  it('rejects ciphertext, tag, hash, and authenticated-context tampering', () => {
    const encryption = service();
    const envelope = encryption.encryptJson({ fixture: true }, context);
    const tamperedCiphertext = Uint8Array.from(envelope.ciphertext);
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 1;
    const tamperedTag = Uint8Array.from(envelope.authenticationTag);
    tamperedTag[0] = (tamperedTag[0] ?? 0) ^ 1;

    expect(() =>
      encryption.decryptJson(changed(envelope, { ciphertext: tamperedCiphertext }), context),
    ).toThrow(PayloadAuthenticationError);
    expect(() =>
      encryption.decryptJson(changed(envelope, { authenticationTag: tamperedTag }), context),
    ).toThrow(PayloadAuthenticationError);
    expect(() =>
      encryption.decryptJson(changed(envelope, { payloadSha256: '0'.repeat(64) }), context),
    ).toThrow(PayloadAuthenticationError);
    expect(() =>
      encryption.decryptJson(envelope, { ...context, workspaceId: 'different-workspace' }),
    ).toThrow(PayloadAuthenticationError);
    expect(() =>
      encryption.decryptJson(envelope, { ...context, recordId: 'different-record' }),
    ).toThrow(PayloadAuthenticationError);
  });

  it('rejects the wrong key and reports an unavailable row key version', () => {
    const envelope = service().encryptJson({ fixture: true }, context);
    const wrongKey = new PayloadEncryptionService({
      activeKeyVersion: 1,
      keyring: new Map([[1, keyTwo]]),
    });
    const missingKey = new PayloadEncryptionService({
      activeKeyVersion: 2,
      keyring: new Map([[2, keyTwo]]),
    });

    expect(() => wrongKey.decryptJson(envelope, context)).toThrow(PayloadAuthenticationError);
    expect(() => missingKey.decryptJson(envelope, context)).toThrow(MissingEncryptionKeyError);
  });

  it('reads mixed versions and re-encrypts old rows with the active version', () => {
    const oldService = new PayloadEncryptionService({
      activeKeyVersion: 1,
      keyring: new Map([[1, keyOne]]),
    });
    const oldEnvelope = oldService.encryptJson({ fixture: 'rotation' }, context);
    const rotatingService = service(2);

    expect(rotatingService.decryptCanonicalJson(oldEnvelope, context)).toBe(
      '{"fixture":"rotation"}',
    );
    const rotated = rotatingService.reencryptJson(oldEnvelope, context);
    expect(rotated.keyVersion).toBe(2);
    expect(rotated.nonce).not.toEqual(oldEnvelope.nonce);
    expect(rotated.payloadSha256).toBe(oldEnvelope.payloadSha256);
    expect(rotatingService.decryptCanonicalJson(rotated, context)).toBe('{"fixture":"rotation"}');
    expect(rotatingService.reencryptJson(rotated, context)).toBe(rotated);
  });

  it('fails closed for a missing active key or malformed key material', () => {
    expect(
      () => new PayloadEncryptionService({ activeKeyVersion: 2, keyring: new Map([[1, keyOne]]) }),
    ).toThrow(EncryptionConfigurationError);
    expect(
      () =>
        new PayloadEncryptionService({
          activeKeyVersion: 1,
          keyring: new Map([[1, new Uint8Array(31)]]),
        }),
    ).toThrow(EncryptionConfigurationError);
  });

  it('blocks active or still-referenced key retirement', () => {
    const encryption = service(2);

    expect(() => encryption.assertCanRetireKey(2, [])).toThrow(EncryptionKeyRetirementError);
    expect(() => encryption.assertCanRetireKey(1, [1, 2])).toThrow(EncryptionKeyRetirementError);
    expect(() => encryption.assertCanRetireKey(1, [2])).not.toThrow();
    expect(() => encryption.assertReferencedKeyVersionsAvailable([1, 2])).not.toThrow();
    expect(() => encryption.assertReferencedKeyVersionsAvailable([3])).toThrow(
      MissingEncryptionKeyError,
    );
  });
});
