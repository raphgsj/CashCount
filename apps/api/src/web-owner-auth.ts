import { verifyStrictBearerCredential } from './bearer-credential.js';

export interface WebOwnerPrincipal {
  role: 'OWNER';
  service: 'service_web';
  workspaceId: string;
}

export function authenticateWebOwnerCredential(
  authorizationHeader: null | string,
  expectedSecret: string,
  workspaceId: string,
): WebOwnerPrincipal | null {
  if (!verifyStrictBearerCredential(authorizationHeader, expectedSecret)) return null;
  return { role: 'OWNER', service: 'service_web', workspaceId };
}

export function requireWebOwnerCredential(
  authorizationHeader: null | string,
  expectedSecret: string,
): boolean {
  return verifyStrictBearerCredential(authorizationHeader, expectedSecret);
}
