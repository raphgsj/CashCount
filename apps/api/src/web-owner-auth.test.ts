import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { requireWebOwnerCredential } from './web-owner-auth.js';

describe('web-owner credential guard', () => {
  const webSecret = Buffer.alloc(32, 61).toString('base64url');
  const webhookSecret = Buffer.alloc(32, 62).toString('base64url');
  const mcpSecret = Buffer.alloc(32, 63).toString('base64url');

  it('accepts only the strict web-owner bearer credential', () => {
    expect(requireWebOwnerCredential(`Bearer ${webSecret}`, webSecret)).toBe(true);
    expect(requireWebOwnerCredential(`Bearer ${webhookSecret}`, webSecret)).toBe(false);
    expect(requireWebOwnerCredential(`Bearer ${mcpSecret}`, webSecret)).toBe(false);
    expect(requireWebOwnerCredential(webSecret, webSecret)).toBe(false);
    expect(requireWebOwnerCredential(`bearer ${webSecret}`, webSecret)).toBe(false);
    expect(requireWebOwnerCredential(`Bearer ${webSecret} trailing`, webSecret)).toBe(false);
    expect(requireWebOwnerCredential(null, webSecret)).toBe(false);
  });
});
