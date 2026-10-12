# AGENTS.md

AI 开发助手入口。每次开始任务前先读本文件，再按需进入子模块。

---

## 项目概述

red-bean-nian-gao 是一个 AI Agent 对话平台，支持流式对话、工具调用、子 Agent 委派和定时任务调度。

```
red-bean-nian-gao/
├── api-contract/      前后端共享的可执行 API 契约（DTO、路由、错误码、运行时校验）
├── backend/          TypeScript 后端服务（Fastify + PostgreSQL + Redis + MinIO）
├── frontend/         React 前端（Vite + Tailwind CSS + Base UI）
└── design-system/    Design System 展示站点（Quiet Tool UI，Light / Dark 对等）
```

后端产品展示模型、会话聚合与仓储契约位于 `backend/src/modules/agent`。这些契约属于宿主，
不得重新放回 Runtime SDK。
产品本身就是 Harness：每个后端实例在启动期完成依赖组装，此后的能力图保持固定。默认观测适配器位于
`backend/src/infra/observability`，业务代码只依赖中性 Tracer/Decorator 边界。
LLM 实现由 `backend/src/platform/llm` 的启动期封闭 Registry 以静态 Provider 插件注册，
Agent Loader 只接收 Runtime SDK 的中性 `LLMAdapterFactory`，不得直接选择具体 Provider 实现。
工具能力同样由 `backend/src/platform/tool` 的静态 Provider 插件组装；工具注册与 Agent 默认授权
是两个独立决策，Agent Loader 只依赖只读 Tool Catalog。
后端进程的依赖图、HTTP 服务、后台任务和资源关闭集中在 `backend/src/app`；
`backend/src/entrypoint/server.main.ts` 只负责信号、配置和启动调用。`src/app/composition-root.ts` 是显式组装层，不是运行期
Service Locator，业务模块仍只通过构造函数接收依赖。

运行中的实例不安装 Provider、重建能力图或切换 Generation。需要新增协议实现、工具代码或 Runtime
版本时，修改代码、验证并部署新的产品实例；部署平台负责健康检查与旧实例优雅退出。模型、凭据和
Agent 授权等数据库配置可在下一次运行加载时生效，但不在单次流式运行中途更换 Adapter。

产品仓与 `red-bean-qing-tuan` Runtime 仓库按同级目录协作。`runtime.lock` 记录产品已验证的
Runtime 精确 commit；提交产品变更前，`make verify` 会确认 sibling Runtime 位于该 commit
且工作区干净。更新 Runtime 后必须同步更新 lock，并在两仓分别完成验证和提交。

---

## 子模块路由

| 你想做什么       | 去哪里读                                          |
| ---------------- | ------------------------------------------------- |
| 改后端代码       | `backend/AGENTS.md` + `backend/docs/standards/`   |
| 人工追踪后端接口 | `backend/src/README.md`                           |
| 改前端代码       | `frontend/AGENTS.md` + `frontend/docs/standards/` |
| 改设计系统       | `design-system/AGENTS.md`                         |
| 了解后端架构     | `docs/design/backend/architecture.md`             |
| 了解技术选型理由 | `backend/STACK.md`                                |

完整文档导航见 [`docs/README.md`](docs/README.md)。

## API 契约（硬性红线）

`api-contract/` 是 HTTP/SSE 机器契约的唯一事实来源，前后端都只能通过包
`@red-bean/api-contract` 消费，禁止前端从 `backend/src` 导入类型。`docs/contracts/api.md` 是面向人工
审查的语义说明和示例投影，不再定义机器类型。

- 改接口时先修改共享包中的 DTO、`routes.ts`、`error-codes.ts` 或 `validators.ts`，再同步生产者、消费者、
  契约测试和 `docs/contracts/api.md`。
- `api-contract/src/<domain>/dto.ts` 只放纯数据类型；函数、Schema、守卫、归一化和映射必须分别放入
  validator、parser、presenter 或 application service。
- 前后端 package 构建前必须先构建共享契约；统一入口为 `make contract-verify` 和 `make verify`。

**路由路径单一来源（端点目录）**：

- 接口路径文本只允许出现在 `api-contract/src/routes.ts` 的 `API_ROUTES` 命名表；后端注册使用
  `bindRoute`（method/path 取自命名表，`authenticated` 与 `auth` 钩子强制绑定），前端一律通过
  `API_ROUTES` + `buildPath` 拼路径；后端与前端均不得手写路由路径字面量。
- 目录模板语法一律使用 Fastify 原生形式（`:param`、通配 `*`）；`{xxx}` 仅允许出现在文档/OpenAPI 展示投影。
- R1：同一父路径下，同一深度禁止静态段与参数段并存；静态段只能上提为顶层资源或下钻到 `:id` 之下，
  `make contract-verify` 的防撞检查会机械拦截。
- R2：不依赖具体 id 的跨资源/系统级查询不借集合前缀，一律上提为顶层资源。
- R3：id 参数值域限 uuid/数字，静态段用连字符名词复数，两类值域不重叠。

根规则默认适用于整个仓库；模块 `AGENTS.md` 只补充本模块约束，只有明确写出差异时才覆盖根规则。
修改任一路径时，按“根目录 → 目标路径沿途”的顺序读取，冲突以离目标文件最近的明确规则为准。

## 文档分类与生命周期

| 分类 | 目录                           | 生命周期                                                 |
| ---- | ------------------------------ | -------------------------------------------------------- |
| 设计 | `docs/design/` 及模块内设计站  | 活文档；描述当前架构、模块行为与 UI 规范，随实现更新     |
| 契约 | `docs/contracts/`              | 活文档；描述当前 HTTP、SSE 与跨模块接口，随公开行为更新  |
| 指南 | `docs/guides/` 及各模块 README | 活文档；描述当前安装、迁移、部署与操作方式               |
| 标准 | 模块 `docs/standards/`         | 活文档；描述当前编码、测试和开发流程                     |
| 需求 | `docs/specs/` 及模块同名目录   | 任务文档；交付后冻结并保留当时目标，不再承担当前行为说明 |
| 计划 | `docs/plans/` 及模块同名目录   | 任务文档；交付后冻结并保留实施方案与偏差，不随新实现改写 |

进行中的 spec / plan 可以在确认与实施阶段修订；任务交付后应标明状态并冻结。当前行为只能由
design、contract、guide、standard、README 或实际 Design System 页面承载。后续改动不得通过
回写历史 spec / plan 来替代活文档同步。

## 跨客户端 Skill 入口

根与模块 `AGENTS.md` 构成项目开发治理的唯一入口。技术事实由下文路由到的 contract、design、
guide、standard 和源码分别承载；同一条规则只在一个权威位置定义。共享工作流位于 `skills/`：

- `red-bean-development/`：通用开发、文档影响审查与交付核验。
- `design-system-visual-review/`：新功能、页面、组件或主题方案的双专家视觉评审。
- `make-agent-system-tools/`：新增、修改或评审后端 `sys_*` 系统工具。

`.claude/skills/` 与 `.agents/skills/` 只通过符号链接暴露给对应客户端。

共享 Skill 负责按任务范围加载根目录与模块级 `AGENTS.md` 并执行专项工作流，不得复制规则正文。
更新治理规则时修改对应 `AGENTS.md`；更新接口、架构或操作事实时修改其被路由到的权威活文档。

---

## 跨模块通用规则

### 提交与分支

- Commit message：中文描述，格式 `<type>: <简短描述>`（如 `feat:`、`fix:`、`refactor:`、`docs:`、`polish:`）
- 分支命名：`feat/<描述>`、`fix/<描述>`，用 kebab-case
- commit、push、merge、发布及其他外部写入只在用户明确授权时执行；完成本地实现与验证不等于自动获得这些权限。

### 决策权限

- **必须询问**：破坏公开兼容性的 API 变更、不可逆数据操作、产生外部成本或副作用、计划外的新生产依赖，
  以及改变尚未获批的安全边界。已批准迁移中的 Fastify、PostgreSQL、Redis、MinIO、Croner、
  OpenTelemetry、JWT、bcrypt 等等价依赖及其必要接线无需重复询问。
- **告知后继续**：已批准 spec/plan 内的兼容性接口扩展、可逆跨模块重构和 migration。
- **自主执行**：已批准范围内的实现、测试、文档同步和本地验证；不要对同一已批准决策重复询问。

### 开发流程（6 阶段）

所有变更都要经过需求、计划、编码、验证、文档影响审查和交付，但产物深度按风险分级：

| 级别        | 示例                                                              | 需求与计划产物                                                     |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| 轻量        | 文案、配置、内部重构、小型 bug                                    | 在任务上下文写清验收条件和实施步骤，无需新建 spec/plan             |
| 标准        | 兼容性功能、页面或非破坏性模块增强                                | 明确需求边界和简短计划；可写在任务记录，按复杂度决定是否建文档     |
| 架构/兼容性 | 新 engine 模块、修改公开 `core/` 接口、新增 migration、破坏性变更 | 必须建立 `docs/specs/` 与 `docs/plans/` 文件；破坏兼容性先取得授权 |

| 阶段    | 产出                               | 说明                                         |
| ------- | ---------------------------------- | -------------------------------------------- |
| 1. 需求 | 验收条件；必要时写 spec            | 做什么、边界在哪                             |
| 2. 计划 | 实施步骤；必要时写 plan            | 技术方案 + 任务拆解                          |
| 3. 编码 | 代码 + 测试                        | 测试策略先行，按下方分层执行                 |
| 4. 验证 | 全绿                               | `make verify`；发布前再跑 `make verify-full` |
| 5. 文档 | design doc / AGENTS.md             | 模块级变更必须更新                           |
| 6. 交付 | 交付说明；按授权 commit/push/merge | 回顾计划与实际一致                           |

模块级变更（新增 engine 模块、修改 `core/` 接口、新增 migration）→ 必须走完 6 阶段。非模块级可以不修改文档，但不能跳过阶段 5 的影响审查。

`make fmt`、`make fe-format` 和各 package 的 `pnpm format` 是修复命令，允许修改文件；
`make verify*` 不得修改 Git 跟踪文件且任一检查失败即退出；构建工具可以写入被忽略的产物和缓存。
`make doctor` 检查仓库声明的 Node.js 与 pnpm 版本，并由 `make verify` 自动执行。统一门禁还包含全仓
Git diff 空白检查、环境文件与高置信度密钥扫描、TypeScript 后端的格式与类型检查、本地 Compose 安全配置检查，以及前端和 Design System
的 Prettier 检查。当前项目不要求远端 CI，以上命令是本地交付门禁。

门禁责任必须明确：工具版本、格式、测试、构建、依赖边界、文档链接和 Skill 链接由对应命令机械检查；
架构合理性、契约语义、文档内容、视觉质量和授权边界仍由开发者或 Agent 人工审查。标为“硬性红线”
不等于已经自动化，未接入命令的规则必须在交付说明中给出人工检查结论。

仓库提供可选的 `make hooks-install`：pre-commit 执行 `make verify-quick`，pre-push 执行
`make verify`。hooks 不得自动安装，也不是唯一门禁；使用 `--no-verify` 后仍须在交付前补跑检查。

详见后端 → [backend/docs/standards/development-workflow.md](backend/docs/standards/development-workflow.md)，前端 → [frontend/docs/standards/development-workflow.md](frontend/docs/standards/development-workflow.md)

### 测试先行分层

项目整体采用行为级 TDD：开始实现可观察行为前，先明确验收条件，并建立会因缺少该行为而失败的测试或验证证据。

- Bug 修复：能自动复现时，先添加失败的回归测试并确认失败原因正确，再修复。
- TypeScript 后端及前端 hooks、store、service、utils 等逻辑：严格执行 Red → Green → Refactor。
- React 组件交互：先列出状态和交互验收场景；可自动化的行为先写失败测试再实现。允许先搭建不含业务行为的结构或样式骨架，但测试必须在功能完成前补齐。
- 纯视觉样式、动画和 Design System 探索：先定义 Showcase 状态与视觉验收条件，通过 Light/Dark、必要视口和人工目视验证，不强行为颜色或像素编写脆弱单测。
- 纯文档、配置、生成文件、机械接线或难以自动化的迁移：可以不先写测试，但必须说明原因并执行最接近风险的静态、构建、契约或手工验证。

TDD 约束的是行为增量，不要求为每一行实现代码单独写测试。重构应在已有测试保持绿色的前提下进行。`make` 只能校验最终结果，不能证明测试编写顺序。

### TypeScript 安全基线

所有现有与新增 TypeScript 代码共同遵循跨仓共享的
[`docs/standards/typescript-common-conventions.md`](docs/standards/typescript-common-conventions.md)
（与 Runtime SDK 仓逐字相同，由 `scripts/check-common-conventions.sh` 校验）；产品仓特有约束见
[`docs/standards/typescript-coding-conventions.md`](docs/standards/typescript-coding-conventions.md)。硬性红线包括：

- 禁止显式 `any`、非空断言、无校验的类型断言、浮空 Promise 与隐式强制转换。
- 错误码/状态码/事件类型/命令 kind 等字面量联合的比较与 case 标签必须引用 const 成员
  （`CODE.X`），禁止字符串字面量（详见 typescript-common-conventions 硬性禁止）。
- 导出函数及 API、SSE、Tool、Checkpoint、持久化和配置边界必须显式标注类型。
- 简单局部值允许可靠推导；不要用 `const count: number = 1` 一类重复标注制造噪声。
- 业务代码禁止 Decorator/Reflect 自动注入、Service Locator、`enum` 与复杂递归类型体操。
- 注入型行为接口必须使用可辨识的角色名；已有 `Repository`、`Adapter`、`Store`、`Registry`、
  `Dispatcher`、`Factory`、`Hook`、`Tracer`、`Loader`、`Runner`、`Collector` 可直接表达 Port 语义，
  含糊的 `Service` 接口必须使用 `ServicePort` 后缀。
- 生产类必须显式 `implements` 它承诺的 Port；Module 内默认实现在对应 `*.module.ts` 中以明确的
  `new ConcreteClass(...)` 绑定，全局 `src/app/composition-root.ts` 只连接基础设施和各 Module 的公开能力，
  不得依赖结构化类型巧合或匿名对象隐藏实现关系。
- 接口只服务于真实的多实现/外部边界/跨模块共享；内部 1:1 且无多实现需求的业务 Service 不建 Port，
  Controller 直接依赖实现类，实现类以"公开方法串联私有小方法"组织，保证一个方法能读完完整流程。
  无 Port 实现类需登记在 `backend/scripts/architecture-rules.mjs` 的 `NON_PORT_IMPLEMENTATION_CLASSES`
  白名单（含改造记录说明）。
- 外部输入从 `unknown` 开始并通过运行时 Schema 校验；静态类型不能替代运行时验证。
- `src/modules/<module>/**/controller/*.dto.ts` 只允许 type re-export；同域的 Schema、parser、serializer、
  presenter 与 Controller 分别放在专责文件中，业务函数归属 Module 内的 application service。
- 业务 Module 的公开 Model/Port 不得直接依赖 Runtime SDK DTO；产品 Session、展示和持久化使用业务自有
  类型，由 Runtime Adapter 负责双向映射。纯数据 model 不放 parser、serializer 或业务函数。
- 禁止用 `eslint-disable`、`@ts-ignore` 或放宽 `tsconfig` 逃避修复。

机械门禁由 `make typecheck`、`make ts-lint` 和 `make ts-policy-check` 执行，并纳入 `make verify`。

### 中文注释规范

- 生产代码的注释和 JSDoc 统一使用简体中文；协议名、类名、字段名等专有标识保留原文。
- 公开入口、跨层边界、复杂状态机、并发与一致性、兼容性字段、安全限制及反直觉分支必须说明设计意图或
  原因，不能只复述代码表面行为。
- DTO、Port、Adapter 和 Application Service 的模块入口应有简短职责注释；必要时说明所有权、失败语义
  或数据转换方向。
- 业务应用服务（Controller / Service 用例）的公开方法必须有职责注释：做什么、边界在哪、何时抛错，
  不能只有方法名。
- 方法体内注释以"意图与取舍、不变量与前提、分支划分依据"为最高价值；翻译式注释允许但低价值，
  不设排除清单——本仓优先保证注释充足。
- 流程超过三个阶段的业务方法推荐使用 `// ── 阶段名 ──` 分段标题，让执行顺序成为视觉事实。
- **唯一注释红线：注释必须与代码一致**（同 diff 更新）；失真注释比没有注释更有害，评审时必查。
- 跨任务决策（为什么选这条路、代价是什么）记入 `docs/decisions/`（ADR 式，只追加不修改）；
  代码注释只承载局部"为什么"。为显而易见的赋值、getter、简单条件逐行加注释仍应避免，但不作为硬禁。
- 测试名称和第三方协议原文可以保留英文，但测试中的非显然 setup、故障注入和断言原因优先使用中文注释。

### 文档影响门禁

每次代码、配置、依赖或目录结构改动完成后，提交前必须查看完整 diff 并完成文档影响审查。阶段 5 可以不修改文档，但不能跳过审查；结论为“无需更新”时，交付说明必须写明理由。

审查必须从 [`docs/README.md`](docs/README.md) 的活文档索引开始，但不能停在索引页：按改动类型
打开索引中所有相关 contract、design、guide、standard 及模块入口，逐份判断是否需要更新。

| 改动类型                                     | 必须检查的权威文档                                            |
| -------------------------------------------- | ------------------------------------------------------------- |
| 架构、模块边界、目录职责、依赖方向或开发门禁 | 根目录或模块 `AGENTS.md`、`docs/design/` 与对应 workflow 文档 |
| 安装、启动、配置、环境变量或用户命令         | `README.md` 及 `docs/guides/` 对应文档                        |
| HTTP、SSE、存储结构或公开接口                | `docs/contracts/` 及相关设计文档                              |
| UI 组件、布局、交互或 design token           | Design System 的 Foundation、Showcase、可下载规范及相关 spec  |
| Runtime SDK 的公开行为或接入方式             | Runtime README、TypeScript 入口、示例、migration 与兼容性说明 |
| 文档新增、删除、移动、重命名或分类变化       | `docs/README.md`、受影响索引项及所有引用该文档的活文档        |

`make docs-check` 校验活文档是否被索引、Markdown 本地链接、Skill 声明及跨客户端符号链接等机械事实；通过不代表被索引文档的语义已经同步。语义判断由开发者或 Agent 在上述审查中完成。

TypeScript 采用两级显式组装：各 `*.module.ts` 是 Module 内实现选择的事实来源，
`src/app/composition-root.ts` 是跨 Module 完整依赖图的事实来源；两层共同由类型检查、Lint、测试与架构审查保证。
