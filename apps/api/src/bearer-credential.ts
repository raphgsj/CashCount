import { createHash, timingSafeEqual } from 'node:crypto';

function credentialDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function verifyStrictBearerCredential(
  authorizationHeader: null | string,
  expectedSecret: string,
): boolean {
  if (authorizationHeader === null) return false;
  const match = /^Bearer ([^\s,]+)$/u.exec(authorizationHeader);
  const presented = match?.[1];
  if (presented === undefined) return false;
  return timingSafeEqual(credentialDigest(presented), credentialDigest(expectedSecret));
}
