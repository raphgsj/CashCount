import { verifyStrictBearerCredential } from './bearer-credential.js';

export interface McpReadOnlyPrincipal {
  role: 'READONLY';
  service: 'service_mcp_readonly';
  workspaceId: string;
}

export function authenticateMcpReadOnlyCredential(
  authorizationHeader: null | string,
  expectedSecret: string,
  workspaceId: string,
): McpReadOnlyPrincipal | null {
  if (!verifyStrictBearerCredential(authorizationHeader, expectedSecret)) return null;
  return { role: 'READONLY', service: 'service_mcp_readonly', workspaceId };
}

export function requireMcpReadOnlyCredential(
  authorizationHeader: null | string,
  expectedSecret: string,
): boolean {
  return verifyStrictBearerCredential(authorizationHeader, expectedSecret);
}
