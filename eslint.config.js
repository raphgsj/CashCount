import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const sourceFiles = ['apps/*/src/**/*.ts', 'packages/*/src/**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    files: sourceFiles,
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message:
            'Read environment variables only in @cashcount/config or an application entrypoint.',
        },
      ],
    },
  },
  {
    files: [
      'packages/config/src/**/*.ts',
      'packages/db/src/migrate-cli.ts',
      'packages/db/src/seed-cli.ts',
      'packages/db/src/*.integration.test.ts',
      'apps/*/src/index.ts',
      'apps/worker/src/discover-cli.ts',
      'apps/worker/src/full-import-cli.ts',
      'apps/worker/src/*.integration.test.ts',
    ],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  {
    files: ['apps/web/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@cashcount/db', '@cashcount/db/*'],
              message:
                'The web application consumes API contracts and must not import database code.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@cashcount/provider-pluggy', '@cashcount/provider-pluggy/*'],
              message: 'The domain package must remain provider-neutral.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/analytics/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@cashcount/provider-pluggy', '@cashcount/provider-pluggy/*', 'apps/*'],
              message:
                'Analytics may depend on domain/database code, not providers or applications.',
            },
          ],
        },
      ],
    },
  },
);
