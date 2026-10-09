# TypeScript 安全与可读性规范

> 文档性质：活文档。适用于产品仓库中的前端、Design System 以及未来 TypeScript API。
> UI 和模块特有规则仍由对应模块标准补充。

## 设计目标

TypeScript 用于减少 Runtime、后端和前端之间的人工类型翻译，不用于把复杂度隐藏在类型体操、
框架反射或隐式 JavaScript 行为中。代码必须同时让编译器、开发者和 AI 审查者能够追踪数据来源、
失败路径与依赖关系。

## 类型标注边界

必须显式标注：

- 导出函数、公开方法和跨模块回调的参数与返回值。
- API、SSE、Tool、Checkpoint、持久化和环境配置边界。
- 类的公开字段、构造函数依赖以及不能从右侧一眼确认的复杂对象。
- 作为协议实现的对象使用显式类型或 `satisfies` 校验。

简单局部常量和已经由声明位置完整约束的回调允许推导。禁止为了形式重复信息：

```ts
const retryCount = 3
const labels = ['running', 'completed'] as const
```

## 硬性禁止

- 生产代码与测试代码不得使用显式 `any`；未知输入从 `unknown` 开始窄化。
- 禁止 `@ts-ignore`；`@ts-expect-error` 仅限类型契约测试，必须写明原因。
- 禁止非空断言 `value!` 和双重断言 `value as unknown as Target`。
- 禁止在生产代码中用 `as Target` 代替校验；`as const` 与经过验证的测试替身不属于此类。
- 禁止 `enum`、运行时代码 namespace、参数属性、Decorator 与 Reflect Metadata。
- 禁止 `eval`、原型修改、Monkey Patch 和依赖运行期扫描的自动注入。
- 禁止 `==`、`!=` 和 `!!value` 等隐式强制转换。惯用的存在性判断可以保留，但涉及空字符串、零值
  与缺失值具有不同业务含义时必须显式比较。
- 禁止浮空 Promise、把异步函数误传给同步回调，以及静默吞掉异步错误。
- 禁止通过放宽 `tsconfig`、关闭整份 ESLint 文件或降低规则级别绕过门禁。
- 错误码、状态码、事件类型、命令 kind 等字面量联合的**比较与 case 标签必须引用 const 成员**
  （`CODE.X`、`EVENT_TYPES.Y`），禁止直接写字符串字面量；字面量联合如无 const 源，先为它建立
  const 映射。理由：成员引用让 IDE 的 Go to Definition / Find Usages 在定义与全部使用点之间
  双向可跳，并防止拼写漂移（详情见 `docs/decisions/2026-09-10-literal-union-member-reference.md`）。
- 禁止把 SDK 或外部协议的字符串常量误映射到本仓自建的状态联合（如 Checkpoint 状态与宿主执行
  结果状态虽同为 `'completed'`，但属于不同域，必须各自引用各自的 const 源）。

## 外部输入

TypeScript 类型在运行时不存在。HTTP body、SSE、数据库 JSON、缓存、环境变量、LLM 输出和 Tool
参数必须在进入可信领域前经过运行时 Schema 校验。禁止直接断言：

```ts
// 禁止
const payload = JSON.parse(raw) as ToolPayload

// 正确方向；具体 Schema 库由迁移设计决定
const rawPayload: unknown = JSON.parse(raw)
const payload = ToolPayloadSchema.parse(rawPayload)
```

校验完成后的领域代码不应反复解析同一数据。API 静态类型、路由、错误码与运行时守卫必须来自
`api-contract/`；公开 Markdown 文档是同步投影。

## 泛型

- 泛型必须表达两个及以上位置之间的真实类型关系；只出现一次的类型参数改用具体类型或 `unknown`。
- 通常最多两个类型参数，并使用 `TInput`、`TOutput`、`TEvent` 等语义名称。
- 业务模块优先使用判别联合和显式接口，不用重载、深层条件类型或递归映射类型隐藏流程。
- 复杂类型工具仅允许位于 Runtime core、契约生成或 tooling，并必须有类型级测试和用途说明。
- 不使用泛型默认值隐藏调用方必须理解的行为。

## 控制流与错误

- 联合类型使用判别字段，并对 `switch` 做穷尽检查。
- 数组或索引访问始终按“可能不存在”处理；先检查再使用。
- 可选字段的“缺失”与“显式 `undefined`”语义不同，不混用。
- `catch` 值视为 `unknown`，通过 `instanceof Error` 或领域解析器窄化。
- 领域错误使用稳定 code 或判别联合；不依赖动态错误文本分支。
- 错误包装必须保留 cause 链（`new Error(message, { cause })`），不得只取 message 重抛使日志与观测
  断链；错误类型可定位性优先于类型纯度（如 `TaskRepositoryError`/`TaskApplicationError` 双类可共存，
  关键是 cause 链不断）。

## 表达式与调用可读性

- **禁止调用点现场组装复杂参数**：方法调用需要多字段对象（约 6+ 字段）、SQL 绑定数组或 DTO 时，
  先在调用处上方构建为具名局部变量再传入——变量名即入参语义文档，调用点必须一眼能读完。
  禁止"DTO 刚组装又解包成位置参数""调用 a 时才现拼 b 对象"等让参数意义悬空的写法。
  同一结构在多处组装时抽具名小函数（如 `buildRunOptions(...)`），消除双路漂移。
- **三元表达式收敛**：禁止嵌套三元、参数内联三元与 `...(cond ? {} : { field })` 条件展开三分；
  多分支用提前 return 或 if/else，空值字段展开用共享具名助手 `optionalField(key, value)`
  （`backend/src/shared/object/optional-field.ts`）。
  单个三元仅允许表达简单二选一且结果一眼可读。

## 判空与可空映射

- 可空字段的判空写法全仓统一：数据库可空列与可选字段按各自类型选用一种语义并写全
  （`=== null` 或 `=== undefined`），禁止三种写法（`=== null`/`=== undefined`/`=== ''`）混用；
  `=== ''` 仅用于业务语义确实为"空字符串"的判定，不作为"缺失"的替代。
- 空值到 DTO/参数的映射用共享具名助手 `optionalField(key, value)`，不逐处
  `...(cond ? {} : { field })` 展开（展开收敛见「表达式与调用可读性」）。

## 命名与签名约定

- 私有成员统一使用 `#` 前缀（运行时真私有），不混写 TypeScript `private` 修饰符。
- 方法参数按"所有者/作用域在前"统一排序（如 `listBySession(userId, sessionId)`）；跨 Repository /
  Service / Tool 复制签名时保持同一参数序，并用测试锁住，防止静默带偏。
- 命名反映真实职责：类名不与真实职责互骗（如 `DeliveryQueue` 类是投递编排服务而非队列容器）、
  避免误导性前缀（如 `Agent*` 指称 Task 自有模型）、同一隐语不在多层指不同概念（如 `commands`
  同时指 service / repository / 仓储依赖）；别名导入避免产生同名双定义（如
  `registerTaskRoutes as bindTaskRoutes`）。

## 依赖与框架

- 依赖通过构造函数或显式工厂传入，不使用 Service Locator 或隐式全局容器。
- 业务代码依赖中性接口；框架对象留在 HTTP、存储和观测适配层。
- 注入型行为接口使用职责后缀。`Repository`、`Adapter`、`Store`、`Registry`、`Dispatcher`、`Factory`、
  `Hook`、`Tracer`、`Loader`、`Runner`、`Collector` 已表达 Port 语义；含糊的 Service 接口命名为
  `*ServicePort`，不得只命名为 `*Service`。
- 接口只服务于真实的多实现/外部边界/跨模块共享；内部 1:1 且无多实现需求的业务 Service 不建 Port，
  Controller 直接依赖实现类。实现类以"公开方法串联私有小方法"组织，保证一个方法能读完完整流程；
  行数红线服从该验收标准（可读性优先于机械行数）。无 Port
  实现类必须登记在 `backend/scripts/architecture-rules.mjs` 的 `NON_PORT_IMPLEMENTATION_CLASSES` 白名单
  并附改造记录说明。
- 生产实现类必须显式 `implements` 对应 Port，不能只依靠 TypeScript 结构化类型兼容。Port JSDoc 应注明
  默认实现及其 composition root；工厂返回协议对象时必须声明返回类型或使用 `satisfies`。
- Module 内默认实现必须在对应 `*.module.ts` 中以 `new ConcreteClass(...)` 显式绑定；跨 Module 能力与
  进程级基础设施再由 `src/app/composition-root.ts` 连接。生产默认实现不得藏在匿名对象、模块副作用或
  运行期扫描中；测试 fake 可以使用对象字面量，但必须接受显式 Port 类型约束。
- 模块依赖保持单向，禁止用 barrel file 掩盖循环依赖。
- Controller 是与 Fastify 解耦的 HTTP 用例控制器：公开方法签名即"入参 + 返回"（入参 DTO/标量与 `AbortSignal`，返回
  wire DTO 或业务流对象），不导入 Fastify 类型；请求解包（parser、`authenticatedPrincipal`、
  `requestAbortSignal`）、成功信封（`shared/http/response.ts` 的 `sendOk`）与 SSE/下载流传输投影归
  `*.routes.ts` 的 handler。这样路由层的实参类型与 parser 返回类型由编译器锁定，"签名即文档"不是约定。
- Controller 按业务面聚合：一个 Controller 承载一个完整业务面的全部端点，不按子域机械拆分；拆分
  触发条件是超行数触发线或端点分属不同资源生命周期。超触发线时先按"端点解包表"评估固有规模，
  记录保留理由后再决定是否拆。
- 不为减少几行样板引入 Decorator、代码扫描或运行期注册魔法。
- `*.module.ts` 按"组装目录"组织：组装体拆成按能力分段的私有工厂函数，函数名即段落标题（如
  `createPersistence`/`createDelivery`/`createScheduler`/`createCases`），主入口只保留解构 + 工厂调用 +
  返回组装；每段配一行中文段标题注释（`// ── 段名 ──` 或 JSDoc），保证组装清单从上到下一条流水线读完，
  不逐行编码对象构造。目录页化只重组模块文件，不改接线对象与行为。
- 错误类与错误码常量放在同行 model（如 `model/session.ts` 的 `SessionStoreError` 与错误码并列），
  不放 `service/` 段——避免架构门禁把 service 段导出类误判为"受管实现"而要求显式 `implements`；
  Controller/Service 使用的领域错误统一从 model 导入。
- `api-contract/src/<module>/dto.ts` 只允许类型和 interface；校验集中在共享 `validators.ts` 或后端
  request parser，序列化、映射和业务函数放在 presenter 或对应 application service。前端不得从后端
  源码导入 DTO，也不得复制共享 wire 类型。

人工审查依赖时按 `依赖字段 → Port → implements → 对应 *.module.ts 中的 new → 实现方法` 追踪；涉及
跨 Module 连接时继续查看 `composition-root.ts`。调用处不直接 `new` 是构造注入的预期结果，两级组装
必须共同补足实现选择的证据链。

## 中文注释

- 生产代码注释与 JSDoc 使用简体中文，专有协议名和代码标识保留原文。
- 面向用户或日志的错误消息使用简体中文（如 `{code, message}` 的 message 与日志文案），协议名词与
  代码标识保留原文；残留英文错误消息属于缺陷而非风格偏好。
- 公开入口、DTO、Port、Adapter、复杂状态机、并发/一致性、安全限制和反直觉分支必须解释设计意图、
  所有权或失败语义。
- 注释说明“为什么”和边界，不逐行复述显而易见的代码；实现变化时同步更新或删除失真注释。
- 测试名称与第三方协议原文可保留英文；非显然的测试准备、故障注入和断言原因优先写中文注释。

## 机械门禁

严格选项与 ESLint 规则以 `tooling/typescript/` 为机械事实来源。至少执行：

```bash
make typecheck
make ts-lint
make ts-policy-check
make verify
```

`make verify*` 是只读检查。格式修复使用明确的写入命令；检查失败后不得用断言、disable 注释或降低配置掩盖问题。

测试工程仍启用 `strict`、禁止 `any` 并接受类型感知 ESLint。测试在断言数组长度后按下标取 fixture 是
常见且可读的写法，因此测试专用配置可以关闭 `noUncheckedIndexedAccess`、精确可选属性和索引签名点访问；
生产源码必须由独立应用配置在完整严格选项下再次检查，测试例外不得被生产 package 继承。
