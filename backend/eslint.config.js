import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

import { restrictedSyntaxRules, typescriptSafetyRules } from '../tooling/typescript/policy.mjs'

export default tseslint.config(
  { ignores: ['node_modules', 'dist', '.test-dist'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...typescriptSafetyRules,
      'no-restricted-syntax': ['error', ...restrictedSyntaxRules],
    },
  }
)
