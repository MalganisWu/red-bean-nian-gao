import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

/**
 * 架构规则的语法与符号隔离层。
 *
 * 本模块是 backend 内**唯一**允许接触 TypeScript 编译器 API 的位置，把源码解析成
 * 与编译器版本无关的中性结构，并对外只提供两个语义查询。架构规则因此不依赖
 * `ts.*` 类型与常量，升级 TypeScript 主版本时只需替换本文件实现：
 *
 * - 语法侧 `parseSourceFile()`：TS 7 可改用 `typescript/unstable/ast` 或等价解析器。
 * - 语义侧 `createSymbolResolver()`：TS 7.0 无公开编译器 API，7.1 的新 API 落地后在本文件接上。
 *
 * 中性结构刻意保持"事实"而非"策略"：这里不做目录判断、白名单过滤或规则命名，
 * 这些仍属于 `architecture-rules.mjs` 的职责。
 */

/** 声明种类；规则按此判定 DTO 纯度与文档要求，不感知编译器节点类型。 */
export const DECLARATION_KINDS = Object.freeze({
  INTERFACE: 'interface',
  TYPE_ALIAS: 'typeAlias',
  CLASS: 'class',
  FUNCTION: 'function',
})

/** 语句种类；`other` 表示非声明、非 import/export 的运行时代码。 */
export const STATEMENT_KINDS = Object.freeze({
  IMPORT: 'import',
  EXPORT: 'export',
  DECLARATION: 'declaration',
  EMPTY: 'empty',
  OTHER: 'other',
})

/**
 * 解析一个 TypeScript 源文件为中性结构。
 *
 * `specifier` 是 import/export 的原始说明符文本（无 moduleSpecifier 时为 `undefined`）；
 * 说明符到磁盘文件的解析（`.js` → `.ts`、`index.ts`、存在性检查）是文件系统关注点，
 * 不经过编译器，因此留在 `architecture-rules.mjs` 的 `resolveImport`。
 * `text` 与 `jsdoc` 已经过裁剪，调用方不需要再访问节点位置。
 */
export function parseSourceFile(fileName, source = readFileSync(fileName, 'utf8')) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  const statements = sourceFile.statements.map((statement) =>
    classifyStatement(statement, sourceFile, source)
  )
  const newExpressions = collectNewExpressions(sourceFile, source)
  return { statements, newExpressions }
}

function classifyStatement(statement, sourceFile, source) {
  if (ts.isImportDeclaration(statement)) {
    return {
      kind: STATEMENT_KINDS.IMPORT,
      specifier: stringLiteralText(statement.moduleSpecifier),
      typeOnly: isTypeOnlyImport(statement),
      bindings: namedImportBindings(statement),
    }
  }
  if (ts.isExportDeclaration(statement)) {
    return {
      kind: STATEMENT_KINDS.EXPORT,
      specifier: stringLiteralText(statement.moduleSpecifier),
      typeOnly: isTypeOnlyExport(statement),
      // names 为 undefined 表示 `export * from` 或不带 moduleSpecifier 的导出声明。
      names: namedExportBindings(statement),
    }
  }
  const declarationKind = declarationKindOf(statement)
  if (declarationKind !== undefined) {
    return {
      kind: STATEMENT_KINDS.DECLARATION,
      declarationKind,
      name: declarationNameOf(statement),
      exported: hasExportModifier(statement),
      jsdoc: leadingJsDoc(source, statement, sourceFile),
      text: statement.getText(sourceFile),
      implementsNames: implementsTypeNames(statement, sourceFile),
      referencedNames: referencedIdentifierNames(statement),
    }
  }
  if (ts.isEmptyStatement(statement)) return { kind: STATEMENT_KINDS.EMPTY }
  return { kind: STATEMENT_KINDS.OTHER }
}

function declarationKindOf(statement) {
  if (ts.isInterfaceDeclaration(statement)) return DECLARATION_KINDS.INTERFACE
  if (ts.isTypeAliasDeclaration(statement)) return DECLARATION_KINDS.TYPE_ALIAS
  if (ts.isClassDeclaration(statement)) return DECLARATION_KINDS.CLASS
  if (ts.isFunctionDeclaration(statement)) return DECLARATION_KINDS.FUNCTION
  return undefined
}

function declarationNameOf(statement) {
  return statement.name?.text
}

function hasExportModifier(statement) {
  return (
    statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
  )
}

function stringLiteralText(node) {
  return node !== undefined && ts.isStringLiteral(node) ? node.text : undefined
}

function namedImportBindings(statement) {
  const clause = statement.importClause
  if (clause === undefined) return []
  const bindings = clause.namedBindings
  if (bindings === undefined || !ts.isNamedImports(bindings)) return []
  return bindings.elements.map((element) => ({
    local: element.name.text,
    imported: element.propertyName?.text ?? element.name.text,
  }))
}

function namedExportBindings(statement) {
  const clause = statement.exportClause
  if (clause === undefined || !ts.isNamedExports(clause)) return undefined
  return clause.elements.map((element) => ({
    local: element.propertyName?.text ?? element.name.text,
    exported: element.name.text,
  }))
}

function isTypeOnlyImport(statement) {
  const clause = statement.importClause
  if (clause === undefined) return false
  if (clause.isTypeOnly) return true
  // `import { type A, type B } from '...'` 在语法上不是整体 type-only，但语义上是；
  // 目录约定把这种写法等同于 type-only import。
  return (
    clause.name === undefined &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((element) => element.isTypeOnly)
  )
}

function isTypeOnlyExport(statement) {
  if (statement.isTypeOnly) return true
  return (
    statement.exportClause !== undefined &&
    ts.isNamedExports(statement.exportClause) &&
    statement.exportClause.elements.length > 0 &&
    statement.exportClause.elements.every((element) => element.isTypeOnly)
  )
}

function implementsTypeNames(statement, sourceFile) {
  if (!ts.isClassDeclaration(statement)) return []
  const clauses =
    statement.heritageClauses?.filter(
      (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword
    ) ?? []
  return clauses.flatMap((clause) => clause.types.map((type) => type.getText(sourceFile)))
}

/**
 * 收集声明公开类型图里的标识符引用。
 *
 * 跳过 Block 与构造签名，以及 `#`/`private` 成员：可读性改造后实现类会直接出现在
 * public-api 类型图中，其方法体、构造依赖与私有字段不属于实例公开类型图。
 * 结果保留声明自身的名字与出现顺序，由规则决定如何过滤。
 */
function referencedIdentifierNames(declaration) {
  const names = []
  const visit = (node) => {
    if (ts.isBlock(node)) return
    if (ts.isConstructorDeclaration(node)) return
    if (
      (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      (ts.isPrivateIdentifier(node.name) ||
        (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Private) !== 0)
    ) {
      return
    }
    if (ts.isIdentifier(node)) names.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(declaration)
  return names
}

function collectNewExpressions(sourceFile, source) {
  const expressions = []
  const visit = (node) => {
    if (ts.isNewExpression(node)) expressions.push(node.expression.getText(sourceFile))
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return expressions
}

/** 取声明前导注释里紧邻的 JSDoc；没有则返回空串。 */
function leadingJsDoc(source, statement, sourceFile) {
  const leading = source.slice(statement.getFullStart(), statement.getStart(sourceFile))
  return leading.match(/\/\*\*[\s\S]*?\*\/\s*$/u)?.[0] ?? ''
}

/**
 * 跨文件符号解析。
 *
 * 只暴露架构规则真正需要的两个语义查询，返回 `{ file, name }` 纯数据；
 * 调用方拿不到编译器符号、节点或类型对象。
 */
export function createSymbolResolver(rootFiles) {
  const program = ts.createProgram({
    rootNames: rootFiles,
    options: {
      allowJs: false,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    },
  })
  const checker = program.getTypeChecker()
  const rootSet = new Set(rootFiles.map((file) => resolve(file)))

  /** 在 `file` 中把 `implements` 写下的类型名解析到具名 interface 声明。 */
  const resolveImplementedInterface = (file, className, interfaceText) => {
    const classNode = findClassDeclaration(program, file, className)
    if (classNode === undefined) return undefined
    const clauses =
      classNode.heritageClauses?.filter(
        (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword
      ) ?? []
    for (const typeNode of clauses.flatMap((clause) => clause.types)) {
      if (typeNode.getText(classNode.getSourceFile()) !== interfaceText) continue
      const symbol = resolveAliasedSymbol(checker, checker.getSymbolAtLocation(typeNode.expression))
      const declaration = symbol?.declarations?.find(ts.isInterfaceDeclaration)
      if (declaration === undefined || declaration.name === undefined) return undefined
      return { file: resolve(declaration.getSourceFile().fileName), name: declaration.name.text }
    }
    return undefined
  }

  /** 在模块文件里把 `new X()` 的表达式文本解析到类声明；越出扫描范围返回 `undefined`。 */
  const resolveConstructedClass = (file, expressionText) => {
    const sourceFile = program.getSourceFile(file)
    if (sourceFile === undefined) return undefined
    let resolved
    const visit = (node) => {
      if (resolved !== undefined) return
      if (ts.isNewExpression(node) && node.expression.getText(sourceFile) === expressionText) {
        const symbol = resolveAliasedSymbol(checker, checker.getSymbolAtLocation(node.expression))
        const declaration = symbol?.declarations?.find(ts.isClassDeclaration)
        const name = declaration?.name?.text
        const target = declaration?.getSourceFile().fileName
        if (name !== undefined && target !== undefined && rootSet.has(resolve(target))) {
          resolved = { file: resolve(target), name }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
    return resolved
  }

  return { resolveImplementedInterface, resolveConstructedClass }
}

function findClassDeclaration(program, file, className) {
  const sourceFile = program.getSourceFile(file)
  const declaration = sourceFile?.statements.find(
    (statement) => ts.isClassDeclaration(statement) && statement.name?.text === className
  )
  return declaration !== undefined && ts.isClassDeclaration(declaration) ? declaration : undefined
}

function resolveAliasedSymbol(checker, initialSymbol) {
  let symbol = initialSymbol
  const visited = new Set()
  while (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    if (visited.has(symbol)) return undefined
    visited.add(symbol)
    symbol = checker.getAliasedSymbol(symbol)
  }
  return symbol
}
