# TypeScript 本仓规范

> 文档性质：活文档。适用于产品仓库中的后端、前端、Design System 与 `api-contract`。
> **通用规则已抽到 [`typescript-common-conventions.md`](typescript-common-conventions.md)**，该文件与
> Runtime SDK 仓 `red-bean-qing-tuan` 逐字相同并由门禁校验。本文件只写产品仓特有的约束；两者冲突
> 时以通用件为准，本文件只做补充。UI 与模块特有规则另由对应模块标准补充。

## 前端与 Design System

- React、无障碍与视觉规则以 [`design-system/AGENTS.md`](../../design-system/AGENTS.md) 与
  [`frontend/AGENTS.md`](../../frontend/AGENTS.md) 为准；本文件只补充与通用规则接壤的部分。
- **JSX 属性位置的多行回调按通用规则「多行即具名」执行，抽到组件体内用 `function` 声明**，
  不用组件体内的 `const` 箭头——保留箭头会让「多行闭包装流程」这条规则在视觉上失去着力点。
  放在组件体内是为了让它读到同一份闭包变量；不要提升到模块级再靠参数传递。
- 前端不得从后端源码导入 DTO，也不得复制共享 wire 类型；一律从 `@red-bean/api-contract` 取。

## 契约来源

- API 静态类型、路由、错误码与运行时守卫的机器可执行唯一源是 [`../../api-contract/src/`](../../api-contract/src/)。
  公开 Markdown 文档（如 `docs/contracts/api.md`）只是它的同步投影。
- `api-contract/src/<module>/dto.ts` 只允许类型和 interface；校验集中在共享 `validators.ts` 或后端
  request parser，序列化、映射和业务函数放在 presenter 或对应 application service。

## HTTP 边界与 Controller

- Controller 是与 Fastify 解耦的 HTTP 用例控制器：公开方法签名即「入参 + 返回」（入参 DTO 或标量
  加 `AbortSignal`，返回 wire DTO 或业务流对象），不导入 Fastify 类型。
- 请求解包（parser、`authenticatedPrincipal`、`requestAbortSignal`）、成功信封
  （`shared/http/response.ts` 的 `sendOk`）与 SSE 或下载流传输投影归 `*.routes.ts` 的 handler。
  这样路由层的实参类型与 parser 返回类型由编译器锁定，「签名即文档」不是约定。
- Controller 按业务面聚合：一个 Controller 承载一个完整业务面的全部端点，不按子域机械拆分；
  拆分触发条件是超出行数触发线或端点分属不同资源生命周期。超触发线时先按「端点解包表」评估
  固有规模，记录保留理由后再决定是否拆。

## 组装与实现绑定

默认实现的绑定落点（`*.module.ts` 与 `src/app/composition-root.ts`、无对应接口实现类的白名单）
见根 [`AGENTS.md`](../../AGENTS.md)「TypeScript 安全基线」。本节只写组装的组织方式：

- `*.module.ts` 按「组装目录」组织：组装体拆成按能力分段的私有工厂函数，函数名即段落标题（如
  `createPersistence` / `createDelivery` / `createScheduler` / `createCases`），主入口只保留
  解构 + 工厂调用 + 返回组装；每段配一行中文段标题注释（`// ── 段名 ──` 或 JSDoc），保证组装清单
  从上到下一条流水线读完，不逐行编码对象构造。目录页化只重组模块文件，不改接线对象与行为。
- 错误类与错误码常量放在同行 model（如 `model/session.ts` 的 `SessionStoreError` 与错误码并列），
  不放 `service/` 段——避免架构门禁把 service 段导出类误判为「受管实现」而要求显式 `implements`；
  Controller 与 Service 使用的领域错误统一从 model 导入。
- 人工审查依赖时按「依赖字段 → Port → implements → 对应 `*.module.ts` 中的 `new` → 实现方法」
  追踪；涉及跨 Module 连接时继续查看 `composition-root.ts`。

## 门禁

严格选项与 ESLint 规则以 `tooling/typescript/` 为机械事实来源。**本仓门禁命令的唯一清单**就在这里；
其他文档只引用，不重列。`make verify` 依次执行：

```bash
make require-install     # 确认依赖已按 lockfile 安装
make doctor              # 工具链版本与 package 声明
make diff-check          # git diff 空白检查
make docs-check          # 文档索引与链接
make shared-files-check  # 跨仓共享件逐字一致
make secrets-check       # 环境文件与高置信度密钥扫描
make compose-check       # 本地 Compose 安全配置
make ts-policy-check     # TypeScript 政策
make ts-export-jsdoc-check # 注释门禁
make backend-verify      # 后端格式、类型、Lint、测试与构建
make frontend-verify     # 前端格式、类型、Lint、测试与构建
make ds-check            # Design System
make sdk-verify          # sibling Runtime SDK 与 runtime.lock 一致
```

`make verify*` 是只读检查。格式修复使用明确的写入命令；检查失败后不得用断言、disable 注释或降低
配置掩盖问题。

测试工程仍启用 `strict`、禁止 `any` 并接受类型感知 ESLint。测试在断言数组长度后按下标取 fixture
是常见且可读的写法，因此测试专用配置可以关闭 `noUncheckedIndexedAccess`、精确可选属性和索引签名
点访问；生产源码必须由独立应用配置在完整严格选项下再次检查，测试例外不得被生产 package 继承。
