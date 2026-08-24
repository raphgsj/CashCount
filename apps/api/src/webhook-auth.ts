import { createHash, timingSafeEqual } from 'node:crypto';

function credentialDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function parseStrictBearer(header: null | string): null | string {
  if (header === null) return null;
  const match = /^Bearer ([^\s,]+)$/u.exec(header);
  return match?.[1] ?? null;
}

export function requirePluggyWebhookCredential(
  authorizationHeader: null | string,
  expectedSecret: string,
): boolean {
  const presented = parseStrictBearer(authorizationHeader);
  if (presented === null) return false;
  return timingSafeEqual(credentialDigest(presented), credentialDigest(expectedSecret));
}
