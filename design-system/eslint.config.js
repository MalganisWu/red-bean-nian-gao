import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

import {
  restrictedSyntaxRules,
  typescriptSafetyRules,
} from '../tooling/typescript/policy.mjs'
import { keyboardActivationRule } from '../tooling/typescript/react-a11y-rules.mjs'

export default tseslint.config(
  { ignores: ['dist', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: typescriptSafetyRules,
  },
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    settings: { react: { version: '19.0' } },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...restrictedSyntaxRules,
        keyboardActivationRule,
        {
          selector: 'Literal[value=/#[0-9A-Fa-f]{3,8}$/]',
          message:
            'No hardcoded hex colors. Use CSS variables via Tailwind utilities (bg-primary, text-foreground) or var(--color-*) tokens.',
        },
        {
          selector: 'Literal[value=/rgba?\\(/]',
          message: 'No hardcoded RGB/RGBA colors. Use CSS variable tokens or Tailwind utilities.',
        },
        {
          selector:
            'JSXAttribute[name.name="style"] ObjectExpression Property[key.name="background"] Literal',
          message: 'No hardcoded background in style. Use bg-* Tailwind utilities.',
        },
        {
          selector: 'JSXAttribute[name.name="style"] ObjectExpression Property[key.name="color"] Literal',
          message: 'No hardcoded color in style. Use text-* Tailwind utilities.',
        },
        {
          selector:
            'JSXAttribute[name.name="style"] ObjectExpression Property[key.name="fontSize"] Literal',
          message: 'No hardcoded fontSize. Use text-* Tailwind utilities.',
        },
      ],
      // Note: Hardcoded Tailwind color utilities like bg-white, text-black, border-black
      // cannot be reliably caught by ESLint selectors because they appear inside
      // CVA string literals. These are enforced via design review and the
      // design-system documentation. Always use token-aware classes:
      // bg-popover (not bg-white), text-foreground (not text-black),
      // border-border (not border-black).
    },
  },
  {
    files: ['**/*.tsx'],
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}', 'src/test-setup.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-empty-function': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['src/foundations/**', 'src/styles/**'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
)
