import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

const workspaces = [
  ['apps/web', '@cashcount/web'],
  ['apps/api', '@cashcount/api'],
  ['apps/worker', '@cashcount/worker'],
  ['apps/mcp', '@cashcount/mcp'],
  ['packages/config', '@cashcount/config'],
  ['packages/contracts', '@cashcount/contracts'],
  ['packages/db', '@cashcount/db'],
  ['packages/domain', '@cashcount/domain'],
  ['packages/provider-core', '@cashcount/provider-core'],
  ['packages/provider-pluggy', '@cashcount/provider-pluggy'],
  ['packages/classification', '@cashcount/classification'],
  ['packages/analytics', '@cashcount/analytics'],
  ['packages/observability', '@cashcount/observability'],
  ['packages/test-fixtures', '@cashcount/test-fixtures'],
] as const;

const architectureDecisionRecords = [
  '0001-typescript-monorepo.md',
  '0002-postgresql-system-of-record.md',
  '0003-provider-adapter-boundary.md',
  '0004-postgres-backed-job-queue.md',
  '0005-vercel-bff-and-railway-api.md',
  '0006-read-only-mcp.md',
  '0007-raw-payload-encryption.md',
  '0008-credential-and-trust-boundaries.md',
  '0009-workspace-integrity.md',
  '0010-provider-identity-and-bill-semantics.md',
] as const;

describe('repository foundation', () => {
  it.each(workspaces)('%s declares its expected package identity and checks', (path, name) => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, path, 'package.json'), 'utf8'));

    expect(manifest).toMatchObject({
      name,
      private: true,
      scripts: {
        build: expect.any(String),
        lint: expect.any(String),
        typecheck: expect.any(String),
      },
    });
  });

  it('pins the supported Node and pnpm versions', () => {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));

    expect(manifest).toMatchObject({
      packageManager: 'pnpm@11.22.0',
      engines: {
        node: '24.19.0',
        pnpm: '11.22.0',
      },
    });
  });

  it('keeps the environment example free of assigned values', () => {
    const environmentLines = readFileSync(join(repositoryRoot, '.env.example'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0 && !line.startsWith('#'));

    expect(environmentLines.length).toBeGreaterThan(0);
    expect(environmentLines.every((line) => /^[A-Z][A-Z0-9_]*=$/.test(line))).toBe(true);
  });

  it.each(architectureDecisionRecords)('%s records a complete accepted decision', (fileName) => {
    const record = readFileSync(join(repositoryRoot, 'docs', 'adr', fileName), 'utf8');

    expect(record).toContain('- **Status:** Accepted');
    expect(record).toContain('## Context');
    expect(record).toContain('## Decision');
    expect(record).toContain('## Alternatives considered');
    expect(record).toContain('## Consequences');
  });

  it('records the complete credential and trust-boundary decision', () => {
    const record = readFileSync(
      join(repositoryRoot, 'docs', 'adr', '0008-credential-and-trust-boundaries.md'),
      'utf8',
    );

    expect(record).toContain('## Credential role and storage matrix');
    expect(record).toContain('## Authorization binding and verification');
    expect(record).toContain('## Rotation protocol');
    expect(record).toContain('## Why MCP calls the read-only Finance API');
    expect(record).toContain('## Adjacent credentials and exclusions');
    expect(record).toContain(
      'Database credentials stay only in services with repository responsibilities',
    );
  });
});
