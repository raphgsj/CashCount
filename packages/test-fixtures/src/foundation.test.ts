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
});
