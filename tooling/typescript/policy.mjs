export const requiredCompilerOptions = Object.freeze({
  strict: true,
  noUncheckedIndexedAccess: true,
  noUncheckedSideEffectImports: true,
  exactOptionalPropertyTypes: true,
  noImplicitReturns: true,
  noImplicitOverride: true,
  noPropertyAccessFromIndexSignature: true,
  useUnknownInCatchVariables: true,
  noFallthroughCasesInSwitch: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  forceConsistentCasingInFileNames: true,
  isolatedModules: true,
  verbatimModuleSyntax: true,
  erasableSyntaxOnly: true,
})

export const requiredPackageScripts = Object.freeze([
  'build',
  'format:check',
  'lint',
  'test',
  'typecheck',
])

export const typescriptSafetyRules = Object.freeze({
  eqeqeq: ['error', 'always'],
  'no-eval': 'error',
  'no-extend-native': 'error',
  'no-implicit-coercion': 'error',
  '@typescript-eslint/ban-ts-comment': [
    'error',
    {
      'ts-check': false,
      'ts-expect-error': 'allow-with-description',
      'ts-ignore': true,
      'ts-nocheck': true,
      minimumDescriptionLength: 12,
    },
  ],
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { fixStyle: 'separate-type-imports', prefer: 'type-imports' },
  ],
  '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
  '@typescript-eslint/explicit-module-boundary-types': [
    'error',
    { allowHigherOrderFunctions: true, allowTypedFunctionExpressions: true },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/no-non-null-assertion': 'error',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      destructuredArrayIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/no-confusing-void-expression': 'off',
  '@typescript-eslint/no-deprecated': 'off',
  '@typescript-eslint/no-dynamic-delete': 'off',
  '@typescript-eslint/no-unnecessary-condition': 'off',
  '@typescript-eslint/no-unnecessary-type-assertion': 'error',
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
  '@typescript-eslint/only-throw-error': 'error',
  '@typescript-eslint/restrict-plus-operands': 'error',
  '@typescript-eslint/restrict-template-expressions': [
    'error',
    { allowBoolean: true, allowNullish: false, allowNumber: true },
  ],
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
})

export const intentionallyDisabledRules = Object.freeze([
  '@typescript-eslint/no-confusing-void-expression',
  '@typescript-eslint/no-deprecated',
  '@typescript-eslint/no-dynamic-delete',
  '@typescript-eslint/no-unnecessary-condition',
])

export const restrictedSyntaxRules = Object.freeze([
  {
    selector: 'TSEnumDeclaration',
    message: '禁止 TypeScript enum；使用字面量联合或 as const 对象。',
  },
  {
    selector: 'TSModuleDeclaration',
    message: '禁止运行时代码 namespace；使用 ES module。',
  },
  {
    selector: 'Decorator',
    message: '禁止 Decorator/Reflect 隐式注册；使用显式构造与工厂。',
  },
  {
    selector: "CallExpression[callee.object.name='Object'][callee.property.name='setPrototypeOf']",
    message: '禁止修改原型。',
  },
])
