import { Buffer } from 'node:buffer';

import { parseMcpConfig } from '@cashcount/config';
import { describe, expect, it } from 'vitest';

function encodedBytes(fill: number): string {
  return Buffer.alloc(32, fill).toString('base64');
}

function validMcpEnvironment(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    MCP_PUBLIC_URL: 'https://mcp.cashcount.example',
    FINANCE_API_PRIVATE_URL: 'http://cashcount-api.railway.internal',
    MCP_CLIENT_TO_MCP_TOKEN: encodedBytes(1),
    MCP_TO_API_READONLY_TOKEN: encodedBytes(2),
    MCP_RATE_LIMIT_PER_MINUTE: '60',
  };
}

describe('MCP environment', () => {
  it('parses a valid configuration and converts the rate limit', () => {
    const config = parseMcpConfig(validMcpEnvironment());

    expect(config.MCP_RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(config.MCP_CLIENT_TO_MCP_TOKEN).not.toBe(config.MCP_TO_API_READONLY_TOKEN);
  });

  it('names a missing client-to-MCP credential', () => {
    const environment = validMcpEnvironment();
    delete environment['MCP_CLIENT_TO_MCP_TOKEN'];

    expect(() => parseMcpConfig(environment)).toThrowError(/MCP_CLIENT_TO_MCP_TOKEN/);
  });

  it('rejects reuse across the two MCP trust boundaries', () => {
    const environment = validMcpEnvironment();
    environment['MCP_TO_API_READONLY_TOKEN'] = environment['MCP_CLIENT_TO_MCP_TOKEN'];

    expect(() => parseMcpConfig(environment)).toThrowError(/must not reuse/);
  });

  it('rejects a non-positive rate limit', () => {
    const environment = validMcpEnvironment();
    environment['MCP_RATE_LIMIT_PER_MINUTE'] = '0';

    expect(() => parseMcpConfig(environment)).toThrowError(/MCP_RATE_LIMIT_PER_MINUTE/);
  });
});
