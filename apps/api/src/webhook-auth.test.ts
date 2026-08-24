import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { requirePluggyWebhookCredential } from './webhook-auth.js';

describe('Pluggy webhook credential guard', () => {
  const secret = Buffer.alloc(32, 41).toString('base64url');
  const wrongSecret = Buffer.alloc(32, 42).toString('base64url');

  it('accepts only a strict bearer credential on the webhook guard', () => {
    expect(requirePluggyWebhookCredential(`Bearer ${secret}`, secret)).toBe(true);
    expect(requirePluggyWebhookCredential(`Bearer ${wrongSecret}`, secret)).toBe(false);
    expect(requirePluggyWebhookCredential(secret, secret)).toBe(false);
    expect(requirePluggyWebhookCredential(`bearer ${secret}`, secret)).toBe(false);
    expect(requirePluggyWebhookCredential(`Bearer ${secret} trailing`, secret)).toBe(false);
    expect(requirePluggyWebhookCredential(null, secret)).toBe(false);
  });
});
