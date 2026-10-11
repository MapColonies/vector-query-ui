import tsBaseConfig, { namingConventions } from '@map-colonies/eslint-config/ts-base';
import reactConfig from '@map-colonies/eslint-config/react';
import vitestConfig from '@map-colonies/eslint-config/vitest';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

export default defineConfig(
  vitestConfig,
  tsBaseConfig,
  reactConfig,
  { settings: { react: { version: 'detect' } } },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/naming-convention': [
        ...namingConventions,
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
        { selector: 'function', format: ['camelCase', 'PascalCase'] },
        { selector: 'variable', modifiers: ['const'], format: ['camelCase', 'UPPER_CASE', 'PascalCase'] },
        { selector: ['typeProperty', 'objectLiteralProperty'], format: ['camelCase', 'PascalCase'] },
        { selector: 'typeProperty', filter: '^__APP_CONFIG__$', format: null },
      ],
      'import-x/exports-last': 'off',
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    files: ['src/components/CodeEditor.tsx'],
    rules: { 'import-x/default': 'off' },
  },
  {
    files: ['**/*.tsx'],
    rules: { '@typescript-eslint/no-magic-numbers': 'off' },
  },
  {
    files: ['scripts/**/*.mjs', '.husky/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
  { ignores: ['dist', 'reports', 'coverage', 'vitest.config.ts', 'vite.config.ts', 'eslint.config.mjs', 'scripts/*.d.mts'] }
);
