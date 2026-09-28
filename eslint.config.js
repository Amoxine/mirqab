import js from '@eslint/js';
import ts from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/*.config.js',
      '**/*.config.ts',
      'packages/database/prisma/**',
      // Plain-Node scripts that run INSIDE a container against dist/, not part of any tsconfig
      // project — typed linting can only report "not found by the project service" for them.
      '**/test/e2e/*.mjs',
      'apps/web/scripts/*.js',
      // CI guard scripts (render-inventory, check-locale-keys), each covered by its own `node --test`
      // or guard step instead.
      'infra/scripts/*.mjs',
      // Next-generated, not part of src's tsconfig include and explicitly "should not be edited".
      'apps/web/next-env.d.ts',
    ],
  },

  // Base JS config
  js.configs.recommended,

  // TypeScript config
  ...ts.configs.strictTypeChecked,
  ...ts.configs.stylisticTypeChecked,

  // Base settings for all files
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },

  // TypeScript specific rules
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
    },
  },

  // React config
  {
    files: ['**/*.{jsx,tsx}'],
    plugins: {
      react,
      'react-hooks': reactHooks,
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      // WP12b guard (DoD-OWNER 2, i18n): a bare JSX text literal is a string that skipped
      // next-intl. Wrap real punctuation/separators in `{'...'}` — that is not a translation gap,
      // just a way to tell this rule the literal was a deliberate choice, not a missed t() call.
      'react/jsx-no-literals': 'error',
    },
    settings: {
      react: { version: 'detect' },
    },
  },

  // Next.js specific rules
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: {
      '@next/next': nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },

  // WP23: the portal is a separate identity domain (Kratos session, no dashboard RBAC — see
  // DeveloperAuthGuard on the api side). This is the client-side/build-time half of that property:
  // the api already refuses a Kratos session on a dashboard route and a Hydra JWT on a portal one,
  // and this refuses the import that would make a portal PAGE assume RBAC it was never given. A
  // core ESLint rule, not a new dependency — no-restricted-imports already does exactly this.
  {
    files: ['apps/web/src/app/portal/**/*.{ts,tsx}', 'apps/web/src/components/portal/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/(dashboard)/**'],
              message: 'Portal code may not import from the dashboard route group — separate auth domain (WP23).',
            },
          ],
          paths: [
            {
              name: '@/components/auth/permission-gate',
              message: 'Portal code may not use dashboard RBAC guards (PermissionGate/PagePermissionGate) — a developer session has no permissions to gate on (WP23).',
            },
            {
              name: '@/hooks/use-permissions',
              message: 'Portal code may not use the dashboard RBAC hook (usePermissions) — a developer session has no permissions to check (WP23).',
            },
          ],
        },
      ],
    },
  },
];
