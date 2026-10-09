import { readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import {
  DECLARATION_KINDS,
  STATEMENT_KINDS,
  createSymbolResolver,
  parseSourceFile,
} from './architecture-syntax.mjs'

const IMPORT_PATTERN = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g

/**
 * 这些例外对应正在拆除的历史跨模块依赖。列表必须精确到源文件与目标文件，
 * 因而不会允许同目录新增同类依赖；完成迁移后应直接删除对应条目。
 */
const CROSS_MODULE_MIGRATION_EXCEPTIONS = new Set()

/**
 * 合法跨能力实现必须精确登记“实现文件#类 -> 接口文件#接口”。
 * 同能力目录下 `service|adapter|serializer -> port` 的常规绑定无需登记。
 */
const CROSS_CAPABILITY_IMPLEMENTATION_BINDINGS = new Map([
  [
    'agent/session/repository/adapter/memory-session-repository.ts#MemoryMessageBuffer',
    new Set(['agent/session/message-buffer/port/message-buffer.port.ts#MessageBuffer']),
  ],
  [
    'agent/presentation/service/section-collector.ts#SectionCollector',
    new Set([
      'agent/subagent/run/port/child-execution-lifecycle.port.ts#ChildSectionCollector',
      'agent/subagent/service/subagent-display.ts#SectionEventCollector',
    ]),
  ],
  [
    'agent/subagent/adapter/child-execution-observer.ts#ChildExecutionObserver',
    new Set([
      'agent/execution/port/agent-executor.ts#AgentExecutionEventSink',
      'agent/execution/port/agent-executor.ts#AgentExecutionMessageObserver',
    ]),
  ],
  [
    'agent/subagent/adapter/runtime-delegation-runner.ts#RuntimeChildRunner',
    new Set(['agent/execution/model/agent-execution-contract.ts#AgentChildRunner']),
  ],
  [
    'agent/subagent/recovery/service/default-sub-execution-recovery.ts#SubExecutionRecovery',
    new Set(['agent/loader/port/agent-loader.port.ts#AgentRunPreparation']),
  ],
  [
    'agent/subagent/service/subagent-display.ts#SubExecDisplayRegistry',
    new Set(['agent/loader/port/agent-loader.port.ts#SubAgentDisplayRegistryPort']),
  ],
  // 会话事实日志写入路径：
  // 写入器实现执行事件 Port，模型观察器实现执行契约的模型 Port。
  [
    'agent/run-facts/service/run-fact-recorder.ts#RunFactRecorder',
    new Set(['agent/execution/port/agent-executor.ts#AgentExecutionEventSink']),
  ],
  [
    'agent/run-facts/service/run-fact-model-observer.ts#RunFactModelObserver',
    new Set(['agent/execution/model/agent-execution-contract.ts#AgentModelAdapter']),
  ],
  // 审批挂起事实的 dispatcher 装饰器（spec/plan 的 R7）：产品在组装执行定义时包一层，
  // 只因 interrupting 工具不发 tool_start/tool_result，宿主必须自己记挂起事实。
  [
    'agent/run-facts/service/approval-fact-dispatcher.ts#ApprovalFactToolDispatcher',
    new Set(['agent/execution/model/agent-execution-contract.ts#AgentToolDispatcher']),
  ],
  [
    'task/service/delivery/default-task-delivery-service.ts#DeliveryQueue',
    new Set([
      'agent/task-result-delivery/port/task-result-delivery.port.ts#TaskResultDeliveryPort',
    ]),
  ],
  [
    'task/service/persistence/command/postgres-task-command-repository.ts#PostgresTaskCommandRepository',
    new Set([
      'task/service/tool/port/scheduled-task-management-repository.port.ts#ScheduledTaskManagementCommandRepository',
    ]),
  ],
  [
    'task/service/persistence/query/postgres-task-query-repository.ts#PostgresTaskQueryRepository',
    new Set([
      'task/service/scheduling/port/task-scheduler.port.ts#PendingTaskRepository',
      'task/service/tool/port/scheduled-task-management-repository.port.ts#ScheduledTaskManagementQueryRepository',
    ]),
  ],
  ['task/task.module.ts#DefaultTaskPersistence', new Set(['task/task.module.ts#TaskPersistence'])],
  [
    'task/service/tool/scheduled-task-tool.ts#ScheduledTaskManageTool',
    new Set(['agent/execution/model/agent-execution-contract.ts#AgentTool']),
  ],
])

/**
 * 这些导出类不承诺可替换 Port，豁免 explicit-implements：
 * - 同能力内部的纯协作对象（DisplayMessageCollector 等）
 * - 内部 1:1 业务实现类（可读性改造定案：无多实现/跨模块需求的 Service 不建 Port，Controller 直接依赖实现类）
 * 新增条目需在提交信息里说明归类理由（为何该实现类不建 Port）。
 */
const NON_PORT_IMPLEMENTATION_CLASSES = new Set([
  'agent/presentation/service/display-message-collector.ts#DisplayMessageCollector',
  // 会话事实日志的 attempt 状态机：
  // 写入器内部纯状态对象，无多实现/跨模块需求，不建 Port。
  'agent/run-facts/service/run-fact-step-buffer.ts#RunFactStepBuffer',
  'agent/presentation/service/presentation-interrupt-assembler.ts#PresentationInterruptAssembler',
  'agent/subagent/service/subagent-display.ts#SectionBuildNode',
  'agent/subagent/tool-factory/adapter/runtime-subagent-tool-factory.ts#RuntimeSubAgentToolFactory',
  'agent/session/query/service/default-session-query-service.ts#DefaultSessionQueryService',
  // 会话轨迹只读查询：内部 1:1 无 Port 实现类
  'agent/trajectory/service/default-trajectory-service.ts#DefaultTrajectoryService',
  'identity/service/application/profile/identity-profile-service.ts#IdentityProfileService',
  'identity/service/application/registration/identity-registration-service.ts#IdentityRegistrationService',
  'storage/service/application/storage-service.ts#StorageService',
  // task 可读性改造：内部 1:1 无 Port 实现类
  'task/service/cases/task-command-service.ts#TaskCommandService',
  'task/service/cases/task-query-service.ts#TaskQueryService',
  'task/service/scheduling/task-execution-service.ts#TaskExecutionService',
  'task/service/scheduling/scheduled-task-worker.ts#ScheduledTaskWorker',
])

const FORBIDDEN_SOURCE_DIRECTORIES = ['api', 'engine', 'cli']
const FORBIDDEN_TEST_DIRECTORIES = ['api', 'engine', 'cli']

export function analyzeArchitecture(sourceRoot, options = {}) {
  const absoluteRoot = resolve(sourceRoot)
  const modulesRoot = join(absoluteRoot, 'modules')
  const sourceFiles = listTypeScriptFiles(absoluteRoot)
  const files = listTypeScriptFiles(modulesRoot)
  const sourceImports = sourceFiles.flatMap((file) => parseImports(file, absoluteRoot))
  const imports = files.flatMap((file) => parseImports(file, absoluteRoot))
  // 符号解析集中由 architecture-syntax.mjs 提供；本文件不接触编译器 API。
  const resolver = createSymbolResolver(files)
  return [
    ...checkControllerDependencies(imports, modulesRoot),
    ...checkLayerDependencies(imports, modulesRoot),
    ...checkDomainApplicationFrameworkImports(files, modulesRoot),
    ...checkServiceConstructions(files, modulesRoot),
    ...checkCrossModuleImports(imports, modulesRoot),
    ...checkNonModuleModuleImports(sourceImports, absoluteRoot, modulesRoot),
    ...checkModuleApplicationImports(sourceImports, absoluteRoot, modulesRoot),
    ...checkPublicApiTransportExports(files, modulesRoot),
    ...checkPublicApiOutboundExports(files, modulesRoot),
    ...checkPublicApiIndirectOutboundLeaks(files, imports, modulesRoot),
    ...checkImplementationTypeReExports(files, modulesRoot),
    ...checkRouteConstruction(files, modulesRoot),
    ...checkDtoPurity(absoluteRoot, options.contractRoot),
    ...checkChineseBoundaryDocumentation(files, modulesRoot),
    ...checkTaskRuntimeImports(files, modulesRoot),
    ...checkRuntimeSdkImportWhitelist(sourceFiles, absoluteRoot),
    ...checkPublicApiRuntimeLeaks(files, imports, modulesRoot),
    ...checkImplementationContracts(files, modulesRoot, resolver),
    ...checkModuleCycles(imports, modulesRoot),
    ...checkApplicationModuleImports(sourceImports, absoluteRoot, modulesRoot),
    ...checkForbiddenDirectories(absoluteRoot, options.testRoot),
    ...checkTestCapabilityMirror(absoluteRoot, options.testRoot),
  ]
}

/** 文件规模只触发人工职责审查，不把合理的大型状态机误判为构建失败。 */
export function analyzeArchitectureWarnings(sourceRoot, testRoot) {
  const absoluteRoot = resolve(sourceRoot)
  return [
    ...checkFileSizeWarnings(listTypeScriptFiles(join(absoluteRoot, 'modules')), absoluteRoot),
    ...(testRoot === undefined
      ? []
      : checkTestFileSizeWarnings(safeListTypeScriptFiles(resolve(testRoot)), resolve(testRoot))),
  ]
}

function checkPublicApiTransportExports(files, modulesRoot) {
  return files.flatMap((file) => {
    if (!file.endsWith(`${sep}public-api.ts`)) return []
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(IMPORT_PATTERN)].flatMap((match) => {
      const specifier = match[1] ?? ''
      if (!specifier.includes('/controller/') && !specifier.endsWith('/http-api.js')) return []
      return [
        {
          rule: 'public-api-transport-export',
          file: normalizePath(relative(modulesRoot, file)),
          message: `领域 public-api 不得导出 Controller、Routes 或 HTTP transport；当前导出：${specifier}`,
        },
      ]
    })
  })
}

function checkPublicApiOutboundExports(files, modulesRoot) {
  return files.flatMap((file) => {
    if (!file.endsWith(`${sep}public-api.ts`)) return []
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(IMPORT_PATTERN)].flatMap((match) => {
      const specifier = match[1] ?? ''
      if (
        !specifier.includes('/repository/') &&
        !specifier.includes('/object-storage/') &&
        !specifier.includes('/serializer/') &&
        !specifier.includes('/adapter/')
      )
        return []
      return [
        {
          rule: 'public-api-outbound-export',
          file: normalizePath(relative(modulesRoot, file)),
          message: `领域 public-api 不得暴露 Module 内部 Repository、Adapter 或 serializer；当前导出：${specifier}`,
        },
      ]
    })
  })
}

function checkPublicApiIndirectOutboundLeaks(files, imports, modulesRoot) {
  const publicApiFiles = new Set(files.filter((file) => file.endsWith(`${sep}public-api.ts`)))
  return imports.flatMap((dependency) => {
    if (!publicApiFiles.has(dependency.source)) return []
    const roots = publicApiExportedNames(dependency.source, dependency.target)
    const leaked = roots.flatMap((name) => tracePrivateOutboundTypes(dependency.target, name))
    if (leaked.length === 0) return []
    return [
      violation(
        'public-api-indirect-outbound-leak',
        dependency,
        `public-api 间接导出的类型图不得暴露 Module 私有 Repository、Adapter、serializer 或 ObjectStorage：${[...new Set(leaked)].join(', ')}。`,
        modulesRoot
      ),
    ]
  })
}

function publicApiExportedNames(publicApiFile, targetFile) {
  const parsed = parseSourceFile(publicApiFile)
  return parsed.statements.flatMap((statement) => {
    if (statement.kind !== STATEMENT_KINDS.EXPORT) return []
    if (statement.specifier === undefined) return []
    if (resolveImport(publicApiFile, statement.specifier) !== targetFile) return []
    if (statement.names !== undefined) return statement.names.map((entry) => entry.local)
    return exportedDeclarationNames(parseSourceFile(targetFile))
  })
}

function tracePrivateOutboundTypes(rootFile, rootName) {
  const leaked = []
  const visited = new Set()
  const visitDeclaration = (file, name) => {
    const key = `${file}:${name}`
    if (visited.has(key)) return
    visited.add(key)
    const sourceFile = parseSourceFile(file)
    const declaration = namedDeclarations(sourceFile).get(name)
    if (declaration === undefined) return
    const imports = importedTypeBindings(file, sourceFile)
    const declarations = namedDeclarations(sourceFile)
    // 公开类型图的标识符引用已由隔离层按"跳过方法体、构造签名与私有成员"的口径预先收集，
    // 这里只做图遍历与私有类型判定。
    for (const identifierName of declaration.referencedNames) {
      const imported = imports.get(identifierName)
      if (imported !== undefined) {
        if (isPrivateOutboundType(imported.file, imported.name)) {
          leaked.push(`${imported.name} (${normalizePath(imported.file)})`)
        } else {
          visitDeclaration(imported.file, imported.name)
        }
      } else if (identifierName !== name && declarations.has(identifierName)) {
        visitDeclaration(file, identifierName)
      }
    }
  }
  visitDeclaration(rootFile, rootName)
  return leaked
}

function namedDeclarations(parsed) {
  const declarations = new Map()
  for (const statement of parsed.statements) {
    if (statement.kind !== STATEMENT_KINDS.DECLARATION) continue
    if (statement.name !== undefined) declarations.set(statement.name, statement)
  }
  return declarations
}

function exportedDeclarationNames(parsed) {
  return [...namedDeclarations(parsed).entries()]
    .filter(([, declaration]) => declaration.exported)
    .map(([name]) => name)
}

function importedTypeBindings(file, parsed) {
  const imports = new Map()
  for (const statement of parsed.statements) {
    if (statement.kind !== STATEMENT_KINDS.IMPORT) continue
    if (statement.specifier === undefined) continue
    const target = resolveImport(file, statement.specifier)
    if (target === undefined) continue
    for (const binding of statement.bindings) {
      imports.set(binding.local, { file: target, name: binding.imported })
    }
  }
  return imports
}

function isPrivateOutboundType(file, name) {
  const pathSegments = segments(file)
  return (
    /(?:Repository|ObjectStorage)$/u.test(name) ||
    pathSegments.some((segment) => ['adapter', 'repository', 'serializer'].includes(segment))
  )
}

function checkImplementationTypeReExports(files, modulesRoot) {
  return files.flatMap((file) => {
    const pathSegments = segments(relative(modulesRoot, file))
    if (!pathSegments.some((segment) => ['service', 'adapter', 'model'].includes(segment)))
      return []
    const source = readFileSync(file, 'utf8')
    const parsed = parseSourceFile(file, source)
    return parsed.statements.flatMap((statement) => {
      if (statement.kind !== STATEMENT_KINDS.EXPORT) return []
      if (statement.specifier === undefined) return []
      return [
        {
          rule: 'implementation-type-re-export',
          file: normalizePath(relative(modulesRoot, file)),
          message: '实现与模型文件不得转发其他文件的类型；请直接从权威 Port 或契约路径导入。',
        },
      ]
    })
  })
}

function checkRouteConstruction(files, modulesRoot) {
  return files.flatMap((file) => {
    if (!file.endsWith('.routes.ts')) return []
    const source = readFileSync(file, 'utf8')
    if (!/\bnew\s+[A-Za-z_$][\w$]*Controller\b/u.test(source)) return []
    return [
      {
        rule: 'route-controller-construction',
        file: normalizePath(relative(modulesRoot, file)),
        message: 'Routes 只能接收并绑定 Controller，不得自行构造 Controller。',
      },
    ]
  })
}

function checkDtoPurity(sourceRoot, configuredContractRoot) {
  const contractRoot = resolve(
    configuredContractRoot ?? resolve(sourceRoot, '../../api-contract/src')
  )
  const moduleDtoFiles = listTypeScriptFiles(sourceRoot).filter((file) => file.endsWith('.dto.ts'))
  const contractDtoFiles = safeListTypeScriptFiles(contractRoot).filter((file) =>
    file.endsWith('dto.ts')
  )
  return [
    ...moduleDtoFiles.flatMap((file) => dtoViolations(file, sourceRoot, false)),
    ...contractDtoFiles.flatMap((file) => dtoViolations(file, contractRoot, true)),
  ]
}

function dtoViolations(file, displayRoot, allowDeclarations) {
  const source = readFileSync(file, 'utf8')
  const parsed = parseSourceFile(file, source)
  return parsed.statements.flatMap((statement) => {
    if (statement.kind === STATEMENT_KINDS.IMPORT && statement.typeOnly) return []
    if (statement.kind === STATEMENT_KINDS.EXPORT && statement.typeOnly) return []
    if (allowDeclarations && isPureTypeDeclaration(statement)) return []
    if (statement.kind === STATEMENT_KINDS.EMPTY) return []
    return [
      {
        rule: 'dto-purity',
        file: normalizePath(relative(displayRoot, file)),
        message:
          'DTO 文件只能包含纯类型声明与 type-only import/export；函数、Schema、类和值必须移出。',
      },
    ]
  })
}

/** DTO 白名单只覆盖纯类型声明；class/function 即使 allowDeclarations 也仍然是违规。 */
function isPureTypeDeclaration(statement) {
  return (
    statement.kind === STATEMENT_KINDS.DECLARATION &&
    (statement.declarationKind === DECLARATION_KINDS.INTERFACE ||
      statement.declarationKind === DECLARATION_KINDS.TYPE_ALIAS)
  )
}

function checkChineseBoundaryDocumentation(files, modulesRoot) {
  return files.flatMap((file) => {
    const relativeFile = normalizePath(relative(modulesRoot, file))
    const pathSegments = segments(relative(modulesRoot, file))
    const source = readFileSync(file, 'utf8')
    const parsed = parseSourceFile(file, source)
    return parsed.statements.flatMap((statement) => {
      if (statement.kind !== STATEMENT_KINDS.DECLARATION || !statement.exported) return []
      const isProductionClass =
        statement.declarationKind === DECLARATION_KINDS.CLASS &&
        (pathSegments.includes('service') || pathSegments.includes('adapter'))
      const isPortRole =
        statement.declarationKind === DECLARATION_KINDS.INTERFACE &&
        pathSegments.includes('port') &&
        /(Port|Repository|Registry|Store|Storage|Factory|Loader|Lifecycle)$/u.test(statement.name)
      if (!isProductionClass && !isPortRole) return []
      const comment = statement.jsdoc
      if (!/[\u3400-\u9fff]/u.test(comment)) {
        return [
          {
            rule: 'chinese-boundary-documentation',
            file: relativeFile,
            message: `公开${isProductionClass ? '生产实现' : ' Port'} ${statement.name ?? ''} 缺少中文职责 JSDoc。`,
          },
        ]
      }
      if (isPortRole && !/(默认实现|实现为)/u.test(comment)) {
        return [
          {
            rule: 'port-default-binding-documentation',
            file: relativeFile,
            message: `Port ${statement.name} 的 JSDoc 必须说明默认实现。`,
          },
        ]
      }
      if (isPortRole) {
        const contract = statement.text
        const missingSemantics = []
        if (/(?:ObjectDownload|Readable)/u.test(contract)) {
          if (!/(?:所有权|负责消费|负责释放|负责关闭)/u.test(comment)) {
            missingSemantics.push('流或资源所有权')
          }
          if (!/(?:取消|中止|AbortSignal)/u.test(comment)) missingSemantics.push('取消语义')
          if (!/(?:失败|错误|异常)/u.test(comment)) missingSemantics.push('失败语义')
        }
        if (/HealthPort$/u.test(statement.name)) {
          if (!/(?:调用|探针|readiness)/iu.test(comment)) missingSemantics.push('调用方')
          if (!/(?:module\.ts|Module)/u.test(comment)) missingSemantics.push('Module 组装点')
          if (!/(?:失败|错误|异常|reject)/u.test(comment)) missingSemantics.push('失败语义')
          if (!/(?:取消|中止|AbortSignal)/u.test(comment)) missingSemantics.push('取消语义')
          if (!/(?:所有权|生命周期|创建|关闭)/u.test(comment)) missingSemantics.push('资源所有权')
        }
        if (missingSemantics.length > 0) {
          return [
            {
              rule: 'port-contract-documentation',
              file: relativeFile,
              message: `Port ${statement.name} 的 JSDoc 缺少：${missingSemantics.join('、')}。`,
            },
          ]
        }
      }
      return []
    })
  })
}

function checkFileSizeWarnings(files, sourceRoot) {
  return files.flatMap((file) => {
    const path = normalizePath(relative(sourceRoot, file))
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u).length
    const threshold = file.endsWith('.routes.ts')
      ? 100
      : file.endsWith('.controller.ts')
        ? 200
        : segments(file).includes('adapter')
          ? 300
          : segments(file).includes('service')
            ? 250
            : undefined
    if (threshold === undefined || lines <= threshold) return []
    return [{ file: path, message: `${lines} 行超过 ${threshold} 行职责审查触发线` }]
  })
}

function checkTestFileSizeWarnings(files, testRoot) {
  return files.flatMap((file) => {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/u).length
    if (lines <= 400) return []
    return [
      {
        file: normalizePath(relative(testRoot, file)),
        message: `${lines} 行超过 400 行测试职责审查触发线`,
      },
    ]
  })
}

function checkLayerDependencies(imports, modulesRoot) {
  return imports.flatMap((dependency) => {
    const sourceSegments = segments(relative(modulesRoot, dependency.source))
    const targetSegments = segments(relative(modulesRoot, dependency.target))
    const sourceIsPort = sourceSegments.includes('port')
    const sourceIsService = sourceSegments.includes('service')
    const targetIsAdapter = targetSegments.includes('adapter')
    // service 平铺容器下同时有实现、port 与 model；Port 依赖同容器的接口/模型是合法共享，
    // 只有依赖具体实现文件才违规。
    const targetIsService =
      targetSegments.includes('service') &&
      !targetSegments.includes('port') &&
      !targetSegments.includes('model')

    if (sourceIsPort && (targetIsAdapter || targetIsService)) {
      return [
        violation(
          'layer-dependency',
          dependency,
          'Port 不得依赖 Adapter 或 Service。',
          modulesRoot
        ),
      ]
    }
    if (!sourceIsService || !targetIsAdapter) return []

    return [violation('layer-dependency', dependency, 'Service 不得依赖 Adapter。', modulesRoot)]
  })
}

function checkDomainApplicationFrameworkImports(files, modulesRoot) {
  return files.flatMap((file) => {
    const pathSegments = segments(relative(modulesRoot, file))
    const isBusinessLayer = pathSegments.some((segment) =>
      ['application', 'domain', 'model', 'port', 'service'].includes(segment)
    )
    if (!isBusinessLayer) return []
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(IMPORT_PATTERN)].flatMap((match) => {
      const specifier = match[1] ?? ''
      if (specifier !== 'fastify' && !specifier.startsWith('fastify/')) return []
      return [
        {
          rule: 'framework-dependency',
          file: normalizePath(relative(modulesRoot, file)),
          message: `Domain/Application 层不得依赖 Fastify；当前导入：${specifier}`,
        },
      ]
    })
  })
}

function checkServiceConstructions(files, modulesRoot) {
  const forbiddenConstruction = /\bnew\s+([A-Za-z_$][\w$]*(?:Repository|Lifecycle|Adapter))\b/gu
  return files.flatMap((file) => {
    if (!segments(relative(modulesRoot, file)).includes('service')) return []
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(forbiddenConstruction)].map((match) => ({
      rule: 'service-construction',
      file: normalizePath(relative(modulesRoot, file)),
      message: `Service 不得自行构造 Repository、Lifecycle 或 Adapter；当前构造：${match[1] ?? 'unknown'}`,
    }))
  })
}

const RUNTIME_SDK_IMPORT_PREFIXES = [
  'modules/agent/execution/adapter/',
  'platform/llm/',
  'platform/tool/',
  'platform/observability/',
]

function checkRuntimeSdkImportWhitelist(files, sourceRoot) {
  return files.flatMap((file) => {
    const relativeFile = normalizePath(relative(sourceRoot, file))
    const allowed =
      relativeFile === 'app/composition-root.ts' ||
      RUNTIME_SDK_IMPORT_PREFIXES.some((prefix) => relativeFile.startsWith(prefix))
    if (allowed) return []
    const source = readFileSync(file, 'utf8')
    const specifiers = [...source.matchAll(IMPORT_PATTERN)]
      .map((match) => match[1] ?? '')
      .filter((specifier) => specifier.startsWith('red-bean-qing-tuan'))
    return specifiers.map((specifier) => ({
      rule: 'runtime-sdk-import-boundary',
      file: relativeFile,
      message: `Runtime SDK 只能由 Agent Runtime Adapter、platform 或全局组装根直接导入；当前导入：${specifier}`,
    }))
  })
}

function checkPublicApiRuntimeLeaks(files, imports, modulesRoot) {
  const publicApiFiles = new Set(files.filter((file) => file.endsWith(`${sep}public-api.ts`)))
  return imports.flatMap((dependency) => {
    if (!publicApiFiles.has(dependency.source)) return []
    const targetSegments = segments(dependency.target)
    if (!targetSegments.includes('model') && !targetSegments.includes('port')) return []
    const targetSource = readFileSync(dependency.target, 'utf8')
    const importsRuntime = [...targetSource.matchAll(IMPORT_PATTERN)].some((match) =>
      (match[1] ?? '').startsWith('red-bean-qing-tuan')
    )
    if (!importsRuntime) return []
    return [
      violation(
        'public-api-runtime-leak',
        dependency,
        'public-api 导出的业务 Model/Port 不得直接依赖 Runtime SDK 类型；请在 Runtime Adapter 映射。',
        modulesRoot
      ),
    ]
  })
}

function checkTaskRuntimeImports(files, modulesRoot) {
  const taskRoot = join(modulesRoot, 'task')
  return files.flatMap((file) => {
    if (!file.startsWith(`${taskRoot}${sep}`) || file.includes(`${sep}tool${sep}`)) return []
    const source = readFileSync(file, 'utf8')
    return [...source.matchAll(IMPORT_PATTERN)].flatMap((match) => {
      const specifier = match[1] ?? ''
      if (!specifier.startsWith('red-bean-qing-tuan')) return []
      return [
        {
          rule: 'task-runtime-boundary',
          file: normalizePath(relative(modulesRoot, file)),
          message:
            'Task 业务逻辑只能通过 Agent public-api 调用 Runtime；仅 Tool Adapter 可实现 SDK Tool 协议。',
        },
      ]
    })
  })
}

function listTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listTypeScriptFiles(path)
    return entry.isFile() && path.endsWith('.ts') ? [path] : []
  })
}

function safeListTypeScriptFiles(directory) {
  try {
    return listTypeScriptFiles(directory)
  } catch {
    return []
  }
}

function parseImports(file, sourceRoot) {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(IMPORT_PATTERN)].flatMap((match) => {
    const specifier = match[1]
    if (!specifier?.startsWith('.')) return []
    const target = resolveImport(file, specifier)
    return target === undefined ? [] : [{ source: file, target, specifier, sourceRoot }]
  })
}

function resolveImport(source, specifier) {
  const unresolved = resolve(dirname(source), specifier)
  const candidates = extname(unresolved)
    ? [unresolved.replace(/\.js$/, '.ts')]
    : [`${unresolved}.ts`, join(unresolved, 'index.ts')]
  return candidates.find((candidate) => isFile(candidate))
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function checkControllerDependencies(imports, modulesRoot) {
  return imports.flatMap((dependency) => {
    if (!segments(dependency.source).includes('controller')) return []
    const targetSegments = segments(dependency.target)
    if (!targetSegments.includes('adapter') && !targetSegments.includes('repository')) return []
    return [
      violation(
        'controller-dependency',
        dependency,
        'Controller 只能依赖应用 Port，不得直接依赖 Repository 或 Adapter。',
        modulesRoot
      ),
    ]
  })
}

function checkCrossModuleImports(imports, modulesRoot) {
  return imports.flatMap((dependency) => {
    const sourceModule = moduleOf(dependency.source, modulesRoot)
    const targetModule = moduleOf(dependency.target, modulesRoot)
    if (sourceModule === undefined || targetModule === undefined || sourceModule === targetModule)
      return []
    if (dependency.target === join(modulesRoot, targetModule, 'public-api.ts')) return []
    const key = `${relative(modulesRoot, dependency.source)} -> ${relative(modulesRoot, dependency.target)}`
    if (CROSS_MODULE_MIGRATION_EXCEPTIONS.has(normalizePath(key))) return []
    return [
      violation(
        'module-boundary',
        dependency,
        `跨 Module 只能导入 ${targetModule}/public-api.ts。`,
        modulesRoot
      ),
    ]
  })
}

function checkNonModuleModuleImports(imports, sourceRoot, modulesRoot) {
  const guardedRoots = ['platform', 'shared', 'infra'].map((directory) =>
    join(sourceRoot, directory)
  )
  return imports.flatMap((dependency) => {
    if (!guardedRoots.some((root) => dependency.source.startsWith(`${root}${sep}`))) return []
    const targetModule = moduleOf(dependency.target, modulesRoot)
    if (targetModule === undefined) return []
    if (dependency.target === join(modulesRoot, targetModule, 'public-api.ts')) return []
    return [
      violation(
        'non-module-module-boundary',
        dependency,
        `platform/shared/infra 只能通过 ${targetModule}/public-api.ts 使用业务能力。`,
        sourceRoot
      ),
    ]
  })
}

function checkModuleApplicationImports(imports, sourceRoot, modulesRoot) {
  const applicationRoot = join(sourceRoot, 'app')
  return imports.flatMap((dependency) => {
    if (moduleOf(dependency.source, modulesRoot) === undefined) return []
    if (!dependency.target.startsWith(`${applicationRoot}${sep}`)) return []
    return [
      violation(
        'module-application-dependency',
        dependency,
        '业务 Module 不得反向依赖 app；跨层生命周期类型应下沉到 shared 中性 Port。',
        sourceRoot
      ),
    ]
  })
}

/**
 * 受管实现来源只有两类：Module 中的生产 `new` 绑定，以及
 * `service|adapter|serializer` 目录中的导出类。两者的 class/interface 精确绑定
 * 由 architecture-syntax.mjs 的符号解析器提供。
 */
function checkImplementationContracts(files, modulesRoot, resolver) {
  const targets = new Map()
  for (const binding of productionBindings(files, resolver)) {
    targets.set(`${binding.file}#${binding.name}`, binding)
  }
  for (const implementation of governedImplementationClasses(files, modulesRoot)) {
    targets.set(`${implementation.file}#${implementation.name}`, implementation)
  }

  const usedCrossBindings = new Set()
  const violations = [...targets.values()].flatMap((implementation) => {
    // 白名单同时覆盖 module.ts 中 new 的生产绑定与 service/adapter 目录的受管类两条来源路径。
    const identity = sourceIdentity(implementation.file, implementation.name, modulesRoot)
    if (NON_PORT_IMPLEMENTATION_CLASSES.has(identity)) return []
    return implementationContractViolations(
      implementation,
      modulesRoot,
      resolver,
      usedCrossBindings
    )
  })
  return [
    ...violations,
    ...staleCrossCapabilityBindings(modulesRoot, usedCrossBindings),
    ...staleNonPortImplementationExceptions(modulesRoot),
  ]
}

function governedImplementationClasses(files, modulesRoot) {
  return files.flatMap((file) => {
    if (implementationOwner(file) === undefined) return []
    const parsed = parseSourceFile(file)
    return parsed.statements.flatMap((statement) => {
      if (statement.kind !== STATEMENT_KINDS.DECLARATION) return []
      if (statement.declarationKind !== DECLARATION_KINDS.CLASS) return []
      if (statement.name === undefined || !statement.exported) return []
      const key = sourceIdentity(file, statement.name, modulesRoot)
      if (NON_PORT_IMPLEMENTATION_CLASSES.has(key)) return []
      return [{ file, name: statement.name, implementsNames: statement.implementsNames }]
    })
  })
}

function productionBindings(files, resolver) {
  const moduleFiles = files.filter((file) => file.endsWith('.module.ts'))
  const bindings = new Map()
  for (const moduleFile of moduleFiles) {
    const parsed = parseSourceFile(moduleFile)
    for (const expressionText of parsed.newExpressions) {
      // `new X()` 的 X 可能来自别名导入，必须由符号解析器跨文件追溯；
      // 越出扫描范围（第三方依赖等）的构造点不属于本规则管辖。
      const target = resolver.resolveConstructedClass(moduleFile, expressionText)
      if (target === undefined) continue
      const declaration = findClassStatement(parseSourceFile(target.file), target.name)
      if (declaration === undefined) continue
      bindings.set(`${target.file}#${target.name}`, {
        file: target.file,
        name: target.name,
        implementsNames: declaration.implementsNames,
      })
    }
  }
  return [...bindings.values()]
}

/** 在已解析文件中按名字取顶层 class 声明；不存在或非 class 返回 `undefined`。 */
function findClassStatement(parsed, name) {
  return parsed.statements.find(
    (statement) =>
      statement.kind === STATEMENT_KINDS.DECLARATION &&
      statement.declarationKind === DECLARATION_KINDS.CLASS &&
      statement.name === name
  )
}

function implementationContractViolations(
  implementation,
  modulesRoot,
  resolver,
  usedCrossBindings
) {
  const { file, name: className, implementsNames } = implementation
  if (implementsNames.length === 0) {
    return [
      {
        rule: 'explicit-implements',
        file: normalizePath(relative(modulesRoot, file)),
        message: `受管生产实现 ${className} 必须显式 implements 对应 Port。`,
      },
    ]
  }

  return implementsNames.flatMap((implementedName) => {
    const resolved = resolver.resolveImplementedInterface(file, className, implementedName)
    if (resolved === undefined) {
      return [
        {
          rule: 'implements-source-interface',
          file: normalizePath(relative(modulesRoot, file)),
          message: `${className} 的 implements 必须由 TypeScript 类型系统精确解析到具名 interface。`,
        },
      ]
    }
    const interfaceName = resolved.name
    const interfaceFile = resolved.file
    if (isOwnedCapabilityPort(file, interfaceFile)) return []
    const implementationKey = sourceIdentity(file, className, modulesRoot)
    const interfaceKey = sourceIdentity(interfaceFile, interfaceName, modulesRoot)
    if (CROSS_CAPABILITY_IMPLEMENTATION_BINDINGS.get(implementationKey)?.has(interfaceKey)) {
      usedCrossBindings.add(`${implementationKey} -> ${interfaceKey}`)
      return []
    }
    return [
      {
        rule: 'implements-capability-mismatch',
        file: normalizePath(relative(modulesRoot, file)),
        message: `${className} 实现的 ${interfaceName} 不在同能力 port 目录，且未登记精确跨能力绑定（${implementationKey} -> ${interfaceKey}）。`,
      },
    ]
  })
}

function staleCrossCapabilityBindings(modulesRoot, usedBindings) {
  return [...CROSS_CAPABILITY_IMPLEMENTATION_BINDINGS.entries()].flatMap(
    ([implementationKey, interfaceKeys]) => {
      if (!moduleExistsForIdentity(modulesRoot, implementationKey)) return []
      return [...interfaceKeys].flatMap((interfaceKey) => {
        const tuple = `${implementationKey} -> ${interfaceKey}`
        if (usedBindings.has(tuple)) return []
        return [
          {
            rule: 'stale-implementation-binding',
            file: implementationKey.split('#')[0],
            message: `跨能力绑定白名单已陈旧或未对应实际 implements：${tuple}。`,
          },
        ]
      })
    }
  )
}

function staleNonPortImplementationExceptions(modulesRoot) {
  return [...NON_PORT_IMPLEMENTATION_CLASSES].flatMap((key) => {
    if (!moduleExistsForIdentity(modulesRoot, key)) return []
    const separator = key.lastIndexOf('#')
    const file = join(modulesRoot, key.slice(0, separator))
    const name = key.slice(separator + 1)
    const declaration = findClassStatement(parseSourceFile(file), name)
    const implementsPort = declaration !== undefined && declaration.implementsNames.length > 0
    if (declaration !== undefined && declaration.exported && !implementsPort) return []
    return [
      {
        rule: 'stale-non-port-implementation-exception',
        file: key.split('#')[0],
        message: `非 Port 实现例外已陈旧：${key}。`,
      },
    ]
  })
}

function isOwnedCapabilityPort(implementationFile, interfaceFile) {
  const owner = implementationOwner(implementationFile)
  return owner !== undefined && dirname(interfaceFile) === join(owner, 'port')
}

function implementationOwner(file) {
  const implementationDirectory = dirname(file)
  if (['adapter', 'serializer', 'service'].includes(basename(implementationDirectory))) {
    return dirname(implementationDirectory)
  }
  // 平铺结构（可读性改造）：实现类与 port/ 目录同级的子域，例如 service/authentication/ 下同时有
  // port/ 与 default-auth-service.ts，则该子域目录即能力 owner。
  try {
    if (statSync(join(implementationDirectory, 'port')).isDirectory()) {
      return implementationDirectory
    }
  } catch {
    // port 子目录不存在时按无 owner 处理。
  }
  return undefined
}

function sourceIdentity(file, name, modulesRoot) {
  const relativeFile = relative(modulesRoot, file)
  const path = relativeFile.startsWith('..') ? normalizePath(file) : normalizePath(relativeFile)
  return `${path}#${name}`
}

function moduleExistsForIdentity(modulesRoot, identity) {
  const separator = identity.lastIndexOf('#')
  if (separator <= 0) return false
  try {
    return statSync(join(modulesRoot, identity.slice(0, separator))).isFile()
  } catch {
    return false
  }
}

function checkForbiddenDirectories(sourceRoot, testRoot) {
  const violations = FORBIDDEN_SOURCE_DIRECTORIES.flatMap((directory) =>
    directoryViolation(sourceRoot, directory, 'legacy-source-directory')
  )
  if (testRoot === undefined) return violations
  return [
    ...violations,
    ...FORBIDDEN_TEST_DIRECTORIES.flatMap((directory) =>
      directoryViolation(resolve(testRoot), directory, 'legacy-test-directory')
    ),
  ]
}

function directoryViolation(root, directory, rule) {
  const target = join(root, directory)
  try {
    if (!statSync(target).isDirectory()) return []
  } catch {
    return []
  }
  return [
    {
      rule,
      file: normalizePath(relative(root, target)),
      message: `禁止恢复旧目录 ${normalizePath(relative(root, target))}/；请使用当前模块化目录。`,
    },
  ]
}

function checkModuleCycles(imports, modulesRoot) {
  const graph = new Map()
  for (const dependency of imports) {
    const source = moduleOf(dependency.source, modulesRoot)
    const target = moduleOf(dependency.target, modulesRoot)
    if (source === undefined || target === undefined || source === target) continue
    if (!graph.has(source)) graph.set(source, new Set())
    graph.get(source).add(target)
  }

  const cycles = []
  const visiting = new Set()
  const visited = new Set()
  const path = []
  const visit = (module) => {
    if (visiting.has(module)) {
      const start = path.indexOf(module)
      cycles.push([...path.slice(start), module])
      return
    }
    if (visited.has(module)) return
    visiting.add(module)
    path.push(module)
    for (const target of graph.get(module) ?? []) visit(target)
    path.pop()
    visiting.delete(module)
    visited.add(module)
  }
  for (const module of graph.keys()) visit(module)
  return cycles.map((cycle) => ({
    rule: 'module-cycle',
    file: 'modules',
    message: `检测到 Module 循环依赖：${cycle.join(' -> ')}`,
  }))
}

function checkApplicationModuleImports(imports, sourceRoot, modulesRoot) {
  const applicationRoots = [join(sourceRoot, 'app'), join(sourceRoot, 'entrypoint')]
  return imports.flatMap((dependency) => {
    if (!applicationRoots.some((root) => dependency.source.startsWith(`${root}${sep}`))) return []
    const targetModule = moduleOf(dependency.target, modulesRoot)
    if (targetModule === undefined) return []
    if (dependency.target === join(modulesRoot, targetModule, 'public-api.ts')) return []
    if (
      dependency.source === join(sourceRoot, 'app', 'http-routes.ts') &&
      dependency.target === join(modulesRoot, targetModule, 'http-api.ts')
    ) {
      return []
    }
    return [
      violation(
        'application-module-boundary',
        dependency,
        `应用组装层只能通过 ${targetModule}/public-api.ts 使用业务能力；仅 app/http-routes.ts 可导入 http-api.ts。`,
        sourceRoot
      ),
    ]
  })
}

function checkTestCapabilityMirror(sourceRoot, testRoot) {
  if (testRoot === undefined) return []
  const testModulesRoot = join(resolve(testRoot), 'modules')
  let testFiles
  try {
    testFiles = listTypeScriptFiles(testModulesRoot)
  } catch {
    return []
  }
  return testFiles.flatMap((file) => {
    const [moduleName, capability] = relative(testModulesRoot, file).split(sep)
    if (moduleName === undefined || capability === undefined || capability.endsWith('.ts'))
      return []
    const productionCapability = join(sourceRoot, 'modules', moduleName, capability)
    try {
      if (statSync(productionCapability).isDirectory()) return []
    } catch {
      // 统一在下面报告不存在的能力目录。
    }
    return [
      {
        rule: 'test-capability-mirror',
        file: normalizePath(relative(resolve(testRoot), file)),
        message: `测试能力目录 ${moduleName}/${capability} 在生产 modules 中不存在。`,
      },
    ]
  })
}

function moduleOf(file, modulesRoot) {
  const path = relative(modulesRoot, file)
  if (path.startsWith('..')) return undefined
  return path.split(sep)[0]
}

function violation(rule, dependency, message, modulesRoot) {
  return {
    rule,
    file: normalizePath(relative(modulesRoot, dependency.source)),
    message: `${message} 当前导入：${dependency.specifier} -> ${normalizePath(relative(modulesRoot, dependency.target))}`,
  }
}

function segments(path) {
  return path.split(sep)
}

function normalizePath(path) {
  return path.split(sep).join('/')
}
