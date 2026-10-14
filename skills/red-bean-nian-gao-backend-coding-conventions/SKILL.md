---
name: red-bean-nian-gao-backend-coding-conventions
description: 在 red-bean-nian-gao 中编写、修改、重构或评审 backend 与 api-contract 的 TypeScript 代码，或调整契约、HTTP 边界、Controller、依赖组装、注释时使用；给出这两个 workspace 的编码落点，并指向跨仓共享的通用 TypeScript 规则。frontend 与 design-system 的改动不使用本 Skill，见前端那份。
---

# red-bean-nian-gao 后端编码规范

> 本 Skill 是 **backend 与 api-contract 两个 workspace** 编码规则的唯一事实来源。
> 通用 TypeScript 规则在 [`references/common.md`](references/common.md)——与 Runtime SDK 仓
> `red-bean-qing-tuan` 中的同名文件**逐字相同**，由 `scripts/check-shared-files.mjs` 校验。
> **两者冲突时以通用件为准**；本文件只写这两个 workspace 特有的约束与落点。
> 前端与 Design System 的规则见
> [`../red-bean-nian-gao-frontend-coding-conventions/SKILL.md`](../red-bean-nian-gao-frontend-coding-conventions/SKILL.md)。

**写代码前完整读取两份**：本文件 + [`references/common.md`](references/common.md)。

## 语言与风格

通用规则（类型标注边界、硬性禁止、外部输入、泛型、控制流与错误、函数与流程可读性、表达式与调用
可读性、判空与可空映射、命名与签名约定）全在 [`references/common.md`](references/common.md)。
本仓额外强调：

- 可选字段的缺失与显式 `undefined` 不混用；**数据库 nullable 必须明确映射**。
- `src/modules/<module>/**/controller/*.dto.ts` 只允许 type re-export；同域的 Schema、parser、serializer、
  presenter 与 Controller 分别放在专责文件中，业务函数归属 Module 内的 application service。
- 业务 Module 的公开 Model/Port 不得直接依赖 Runtime SDK DTO；产品 Session、展示和持久化使用业务自有
  类型，由 Runtime Adapter 负责双向映射。纯数据 model 不放 parser、serializer 或业务函数。

## 架构与依赖方向

每个目录持有什么、谁不许依赖谁，见 [`../../backend/AGENTS.md`](../../backend/AGENTS.md)「依赖方向」；
本 Skill 只写写代码时会碰到的约束：

- **产品展示和 Session 属于宿主，不得移回 Runtime。** 产品 Session、恢复缓冲、持久化模型和跨 Module
  Port 使用业务自有类型；SDK 的 Message / Event / Checkpoint 只在 Agent Runtime Adapter 边界映射。
- Fastify、`pg`、Redis、MinIO 和 OpenTelemetry 的具体类型**不得扩散到无关业务模块**，一律停在各自的
  基础设施适配层。
- 生产源码直接导入 `red-bean-qing-tuan` 的白名单仅为 `modules/agent/execution/adapter/`、
  `platform/{llm,tool,observability}/` 和 `app/composition-root.ts`；其他位置依赖业务 Port/Model。
  该约束由 `pnpm architecture:check` 扫描全部 `backend/src`。

## HTTP 边界与 Controller

HTTP 边界按业务能力组织在 `src/modules/<module>/**/controller/`；公开 DTO 集中在
`../../api-contract/src/<module>/dto.ts`。

- Controller 是与 Fastify 解耦的 HTTP 用例控制器：公开方法签名即「入参 + 返回」（入参 DTO 或标量
  加 `AbortSignal`，返回 wire DTO 或业务流对象），**不导入 Fastify 类型、不建立数据库、Redis 或
  MinIO 连接**。
- 请求解包（parser、`authenticatedPrincipal`、`requestAbortSignal`）、成功信封
  （`shared/http/response.ts` 的 `sendOk`）与 SSE 或下载流传输投影归 `*.routes.ts` 的 handler。
  这样路由层的实参类型与 parser 返回类型由编译器锁定，「签名即文档」不是约定。
- 路由 handler 首段解包 `request.params/query/body`；流式端点（SSE、下载流）由路由层做传输投影
  （`sendSse` / `reply.send(stream)`），Controller 只返回业务流对象。**路由不得重新内联同类
  Schema 或 serializer。**
- 输入 Schema 与校验放在 `*-request-parser.ts` 或共享 `validators.ts`；领域到 wire 的纯映射放在
  `*-presenter.ts`。后端同名 `*.dto.ts` 只允许 type re-export，不得增加本地 wire 定义或函数。
- 领域模型和 Repository Port 不依赖 HTTP DTO；持久化 row DTO 也不得与 HTTP DTO 混用。
- Controller 按业务面聚合：一个 Controller 承载一个完整业务面的全部端点，不按子域机械拆分；
  拆分触发条件是超出行数触发线或端点分属不同资源生命周期。超触发线时先按「端点解包表」评估
  固有规模，记录保留理由后再决定是否拆。

## 组装与实现绑定

- `*.module.ts` 按「组装目录」组织：组装体拆成按能力分段的私有工厂函数，函数名即段落标题（如
  `createPersistence` / `createDelivery` / `createScheduler` / `createCases`），主入口只保留
  解构 + 工厂调用 + 返回组装；每段配一行中文段标题注释（`// ── 段名 ──` 或 JSDoc），保证组装清单
  从上到下一条流水线读完，不逐行编码对象构造。目录页化只重组模块文件，不改接线对象与行为。
- 生产类的默认实现在对应 `*.module.ts` 中以明确的 `new ConcreteClass(...)` 绑定，
  `src/app/composition-root.ts` 只连接基础设施和各 Module 的公开能力。**两者都不得退化为运行期
  Service Locator**；生产代码不得用匿名对象充当默认实现。
- factory 返回协议对象时必须声明返回类型或使用 `satisfies`。测试 fake 可使用对象字面量，但必须
  接受显式 Port 类型约束。
- `*RouteDependencies` 等 Controller 依赖清单必须用中文 JSDoc 标明各依赖的生产默认实现，并指向
  对应 `*.module.ts`；涉及跨 Module 绑定时再指向 `src/app/composition-root.ts`。**默认绑定变化时，
  接线代码与该注释必须在同一次变更中更新。**
- 无对应接口的默认实现类登记在 `backend/scripts/architecture-rules.mjs` 的
  `NON_PORT_IMPLEMENTATION_CLASSES` 白名单并附改造记录说明。
- 错误类与错误码常量放在同行 model（如 `model/session.ts` 的 `SessionStoreError` 与错误码并列），
  不放 `service/` 段——避免架构门禁把 service 段导出类误判为「受管实现」而要求显式 `implements`；
  Controller 与 Service 使用的领域错误统一从 model 导入。
- 人工审查依赖时按「依赖字段 → Port → implements → 对应 `*.module.ts` 中的 `new` → 实现方法」
  追踪；涉及跨 Module 连接时继续查看 `composition-root.ts`。调用处没有 `new` 是构造注入的结果，
  **不代表实现关系可以隐式存在**。

## Provider 与运行期边界

- LLM Registry 位于 `src/platform/llm`，Tool Registry 位于 `src/platform/tool`；都在启动期注册后封闭。
- Agent Loader 只接收 Runtime 的中性 `LLMAdapterFactory` 与只读 Tool Catalog。
- 新增工具默认只注册，**不自动加入** Agent 的 `sys_tool_ids`；默认授权是独立的安全决策。
- 模型、端点、凭据和 Agent 授权在下一次运行加载；已经开始的流式运行不切换 Adapter。
- 产品不提供动态代码安装、进程外 Provider 或 Supervisor。部署平台负责实例替换，应用负责探针与优雅退出。

## 契约与公开边界

- API 静态类型、路由、错误码与运行时守卫的机器可执行唯一源是 [`../../api-contract/src/`](../../api-contract/src/)。
  公开 Markdown 文档（如 `docs/contracts/api.md`）只是它的同步投影。
- `api-contract/src/<module>/dto.ts` 只允许类型和 interface；校验集中在共享 `validators.ts` 或后端
  request parser，序列化、映射和业务函数放在 presenter 或对应 application service。
- `public-api.ts` **不得通过业务 Model/Port 转发 Runtime SDK 类型**；公开边界需要的 JSON 与消息结构
  由产品 Module 持有，转换函数放在 Adapter、serializer 或 presenter，不能放进纯数据 model。
- Service、Adapter 和 Model 不得为兼容旧路径转发 Port 或其他权威类型；消费者必须直接从定义文件
  导入。`public-api.ts` 只暴露跨 Module 真正需要的 Model、Port 和组装工厂，**不得直接导出内部
  Repository、Adapter、ObjectStorage 或 serializer helper**。

## 行数触发线

Routes 100 行、Controller 200 行、主 Service 250 行、Adapter 300 行和单个测试 400 行为**职责审查
触发线，不是机械失败线**；超限项必须自然拆分，或在相邻模块 design 中记录保留理由。

## 注释

注释的唯一事实来源是 [`references/common.md`](references/common.md) 的「注释」章节——适用范围、
机械门禁检查什么、书写要求、提交前人工检查，全在那里。本仓额外强调：

- DTO、Port、Adapter 和 Application Service 的模块入口要说明所有权、失败语义或数据转换方向。
- Port 的 JSDoc 应注明默认实现与 composition root 组装位置。
- 新增公开模块、DTO、Port、Adapter 或复杂编排时，必须补充足以支持人工审查的中文职责说明。

## 兼容性与判断边界

- 必须询问：破坏公开兼容性的 API 变更、不可逆数据操作、产生外部成本或副作用、计划外的新生产依赖，
  以及改变尚未获批的安全边界。
- 已批准 plan 内的兼容性接口扩展、可逆跨模块重构和 migration：告知影响后继续。

## 架构门禁（`make be-architecture-check`）

`backend/scripts/check-architecture.mjs` 是快速、只读的边界检查，覆盖：

1. Controller 不得直接依赖 Repository 或 Adapter，只依赖 Application Service Port。
2. 跨 Module import 必须经过目标模块 `public-api.ts`。
3. Module 组装使用的生产默认实现必须显式 `implements` 对应 Port。
4. `adapter/` 中导出的生产类必须显式 `implements` 对应 Port。
5. `public-api.ts` 不得通过公开 Model/Port 转发 Runtime SDK 类型。
6. 白名单外的生产源码不得直接导入 Runtime SDK。
7. 已退役的 `src/api|engine|cli` 与 `test/api|engine|cli` 目录不得恢复。
8. Module 依赖图不得形成循环。
9. Service、Adapter 和 Model 不得转发权威 Port 类型；`public-api.ts` 不得直接导出内部 Repository、
   Adapter 或 serializer helper。
10. 生产文件和测试文件超过职责规模触发线时输出人工审查 warning，不单因行数阻断构建。
11. `platform/shared/infra` 不得绕过业务 `public-api.ts` 深导入 Module，业务 Module 不得反向依赖 `app`。
12. `public-api.ts` 经 `*.module.ts` 间接导出的返回契约也不得泄露 Repository、Adapter、serializer 或
    `ObjectStorage`；门禁会递归追踪别名和多层接口组成的类型图。

**迁移期确需例外时，只能精确登记源文件与目标文件，并在迁移完成后删除；不得把规则放宽为目录级豁免。**
运行入口、例外登记方式与解析机制见
[`../../docs/design/backend/architecture.md`](../../docs/design/backend/architecture.md)「架构机械门禁」。

## 门禁

**本仓门禁命令的唯一清单在根 [`AGENTS.md`](../../AGENTS.md)「门禁」**，本节不重列。
严格选项与 ESLint 规则以 `tooling/typescript/` 为机械事实来源。
