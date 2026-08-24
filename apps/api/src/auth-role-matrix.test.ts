import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { authenticateMcpReadOnlyCredential } from './mcp-readonly-auth.js';
import { authenticateWebOwnerCredential } from './web-owner-auth.js';
import { authenticatePluggyWebhookCredential } from './webhook-auth.js';

const workspaceId = '10000000-0000-4000-8000-000000000060';
const webToken = Buffer.alloc(32, 60).toString('base64url');
const mcpToken = Buffer.alloc(32, 61).toString('base64url');
const webhookToken = Buffer.alloc(32, 62).toString('base64url');

describe('API auth role matrix', () => {
  it('binds each independent credential to one server-owned principal', () => {
    expect(authenticateWebOwnerCredential(`Bearer ${webToken}`, webToken, workspaceId)).toEqual({
      role: 'OWNER',
      service: 'service_web',
      workspaceId,
    });
    expect(authenticateMcpReadOnlyCredential(`Bearer ${mcpToken}`, mcpToken, workspaceId)).toEqual({
      role: 'READONLY',
      service: 'service_mcp_readonly',
      workspaceId,
    });
    expect(authenticatePluggyWebhookCredential(`Bearer ${webhookToken}`, webhookToken)).toEqual({
      service: 'service_webhook',
    });
  });

  it('rejects every cross-boundary substitution and malformed bearer value', () => {
    expect(authenticateWebOwnerCredential(`Bearer ${mcpToken}`, webToken, workspaceId)).toBeNull();
    expect(
      authenticateWebOwnerCredential(`Bearer ${webhookToken}`, webToken, workspaceId),
    ).toBeNull();
    expect(
      authenticateMcpReadOnlyCredential(`Bearer ${webToken}`, mcpToken, workspaceId),
    ).toBeNull();
    expect(
      authenticateMcpReadOnlyCredential(`Bearer ${webhookToken}`, mcpToken, workspaceId),
    ).toBeNull();
    expect(authenticatePluggyWebhookCredential(`Bearer ${webToken}`, webhookToken)).toBeNull();
    expect(authenticatePluggyWebhookCredential(`Bearer ${mcpToken}`, webhookToken)).toBeNull();

    for (const malformed of [null, webToken, `bearer ${webToken}`, `Bearer ${webToken} extra`]) {
      expect(authenticateWebOwnerCredential(malformed, webToken, workspaceId)).toBeNull();
    }
  });
});
