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
    scriptKindOf(fileName)
  )
  const statements = sourceFile.statements.map((statement) =>
    classifyStatement(statement, sourceFile, source)
  )
  const newExpressions = collectNewExpressions(sourceFile, source)
  return { statements, newExpressions }
}

/**
 * 按扩展名选 `ScriptKind`。
 *
 * 拿 `TS` 去解析 `.tsx` 会产出语法错误 AST，而"读坏了 AST"在门禁里的表现是
 * **零成员、零违规**的静默放行 —— 比报错更危险，所以这里必须按扩展名分流。
 * 产品仓的注释门禁要覆盖 frontend 与 design-system，这条是它的前提。
 */
function scriptKindOf(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX
  return ts.ScriptKind.TS
}

/**
 * 文档事实收集：把源码里所有**可文档化**的符号摊平成与编译器节点无关的记录。
 *
 * 与 `parseSourceFile` 的分工：后者给架构规则看"顶层语句骨架"，本函数给注释门禁看
 * "每个符号的注释事实"。记录只承载事实 —— 有没有 JSDoc、参数名是什么、返回类型写了
 * 什么；**"该不该有 tag" 属于纯规则模块 `tooling/typescript/export-jsdoc-rules.mjs`
 * 的策略，不在本文件判定**，这样两个仓的语法层只需产出一致的事实，不必各自复刻规则。
 *
 * `symbolPath` 在单文件内保证唯一（重载实现、声明合并会追加 `#2`、`#3`）：
 * 棘轮基线按 `{file, symbolPath}` 建键，唯一性是它的前提。
 */
export function collectDocumentables(fileName, source = readFileSync(fileName, 'utf8')) {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(fileName)
  )
  const records = []
  const usedPaths = new Set()
  for (const statement of sourceFile.statements) {
    collectStatement(statement, sourceFile, source, records, usedPaths)
  }
  return records
}

function collectStatement(statement, sourceFile, source, records, usedPaths) {
  if (ts.isFunctionDeclaration(statement)) {
    // 有无函数体区分实现与重载签名；签名由实现承载文档。
    if (statement.body === undefined) return
    pushRecord(records, usedPaths, {
      symbolPath: statement.name?.text ?? 'default',
      kind: 'function',
      exported: hasExportModifier(statement),
      jsdocText: leadingJsDoc(source, statement, sourceFile),
      line: lineOf(statement, sourceFile),
      params: simpleParameterNames(statement.parameters),
      hasDestructuredParam: statement.parameters.some(isDestructuredParameter),
      returnTypeText: typeTextOf(statement.type, sourceFile),
    })
    return
  }
  if (ts.isClassDeclaration(statement)) {
    const className = statement.name?.text ?? 'default'
    const exported = hasExportModifier(statement)
    pushRecord(records, usedPaths, {
      symbolPath: className,
      kind: 'class',
      exported,
      jsdocText: leadingJsDoc(source, statement, sourceFile),
      line: lineOf(statement, sourceFile),
      params: [],
      hasDestructuredParam: false,
      returnTypeText: undefined,
    })
    for (const member of statement.members) {
      collectClassMember(member, sourceFile, source, records, usedPaths, className, exported)
    }
    return
  }
  if (ts.isVariableStatement(statement)) {
    const exported = hasExportModifier(statement)
    const jsdocText = leadingJsDoc(source, statement, sourceFile)
    for (const declaration of statement.declarationList.declarations) {
      // 解构绑定的名字不是符号路径，跳过而不是编造一个。
      if (!ts.isIdentifier(declaration.name)) continue
      const callable = callableOf(declaration.initializer)
      pushRecord(records, usedPaths, {
        symbolPath: declaration.name.text,
        kind: callable === undefined ? 'variable' : 'function',
        exported,
        jsdocText,
        line: lineOf(declaration, sourceFile),
        params: callable?.parameters ?? [],
        hasDestructuredParam: callable?.hasDestructuredParam ?? false,
        returnTypeText: callable?.returnTypeText ?? typeTextOf(declaration.type, sourceFile),
      })
    }
    return
  }
  const simpleKind = simpleDeclarationKindOf(statement)
  if (simpleKind !== undefined) {
    pushRecord(records, usedPaths, {
      symbolPath: declarationNameOf(statement) ?? 'default',
      kind: simpleKind,
      exported: hasExportModifier(statement),
      jsdocText: leadingJsDoc(source, statement, sourceFile),
      line: lineOf(statement, sourceFile),
      params: [],
      hasDestructuredParam: false,
      returnTypeText: undefined,
    })
  }
}

/** 只需描述正文、不需要 tag 的声明种类。 */
function simpleDeclarationKindOf(statement) {
  if (ts.isInterfaceDeclaration(statement)) return 'interface'
  if (ts.isTypeAliasDeclaration(statement)) return 'typeAlias'
  if (ts.isEnumDeclaration(statement)) return 'enum'
  if (ts.isModuleDeclaration(statement)) return 'module'
  return undefined
}

function collectClassMember(member, sourceFile, source, records, usedPaths, className, exported) {
  if (isPrivateMember(member)) return
  const base = {
    exported,
    jsdocText: leadingJsDoc(source, member, sourceFile),
    line: lineOf(member, sourceFile),
    params: [],
    hasDestructuredParam: false,
    returnTypeText: undefined,
  }
  if (ts.isConstructorDeclaration(member)) {
    pushRecord(records, usedPaths, {
      ...base,
      symbolPath: `${className}.constructor`,
      kind: 'ctor',
      params: simpleParameterNames(member.parameters),
      hasDestructuredParam: member.parameters.some(isDestructuredParameter),
    })
    return
  }
  const name = memberNameOf(member)
  if (name === undefined) return
  if (ts.isMethodDeclaration(member)) {
    if (member.body === undefined) return
    pushRecord(records, usedPaths, {
      ...base,
      symbolPath: `${className}.${name}`,
      kind: 'method',
      params: simpleParameterNames(member.parameters),
      hasDestructuredParam: member.parameters.some(isDestructuredParameter),
      returnTypeText: typeTextOf(member.type, sourceFile),
    })
    return
  }
  if (ts.isGetAccessorDeclaration(member)) {
    pushRecord(records, usedPaths, {
      ...base,
      symbolPath: `${className}.${name}#get`,
      kind: 'accessor',
      returnTypeText: typeTextOf(member.type, sourceFile),
    })
    return
  }
  if (ts.isSetAccessorDeclaration(member)) {
    pushRecord(records, usedPaths, {
      ...base,
      symbolPath: `${className}.${name}#set`,
      kind: 'accessor',
      params: simpleParameterNames(member.parameters),
      hasDestructuredParam: member.parameters.some(isDestructuredParameter),
    })
    return
  }
  if (ts.isPropertyDeclaration(member)) {
    pushRecord(records, usedPaths, {
      ...base,
      symbolPath: `${className}.${name}`,
      kind: 'property',
      returnTypeText: typeTextOf(member.type, sourceFile),
    })
  }
}

/** 只跳过 `private` 与 `#` 成员；`protected` 属于继承契约，仍纳入。 */
function isPrivateMember(member) {
  if (member.name !== undefined && ts.isPrivateIdentifier(member.name)) return true
  return (ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Private) !== 0
}

function memberNameOf(member) {
  const name = member.name
  if (name === undefined) return undefined
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  if (ts.isPrivateIdentifier(name)) return name.text
  return undefined
}

/**
 * 变量声明初始值是箭头函数或函数表达式时，按函数对待。
 *
 * 不这样做就等于留了一个绕道：把函数写成 `export const f = () => {}` 即可绕开
 * `@param` 要求。返回 `undefined` 表示它不是可调用体（如 zod schema、常量对象）。
 */
function callableOf(initializer) {
  if (initializer === undefined) return undefined
  if (!ts.isArrowFunction(initializer) && !ts.isFunctionExpression(initializer)) return undefined
  return {
    parameters: simpleParameterNames(initializer.parameters),
    hasDestructuredParam: initializer.parameters.some(isDestructuredParameter),
    returnTypeText: typeTextOf(initializer.type, initializer.getSourceFile()),
  }
}

function simpleParameterNames(parameters) {
  const names = []
  for (const parameter of parameters) {
    if (ts.isIdentifier(parameter.name)) names.push(parameter.name.text)
  }
  return names
}

function isDestructuredParameter(parameter) {
  return !ts.isIdentifier(parameter.name)
}

function typeTextOf(node, sourceFile) {
  return node === undefined ? undefined : node.getText(sourceFile)
}

function lineOf(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

/** 同名符号追加序号，保证 `symbolPath` 在单文件内唯一。 */
function pushRecord(records, usedPaths, record) {
  let symbolPath = record.symbolPath
  let ordinal = 2
  while (usedPaths.has(symbolPath)) {
    symbolPath = `${record.symbolPath}#${ordinal}`
    ordinal += 1
  }
  usedPaths.add(symbolPath)
  records.push({ ...record, symbolPath })
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
