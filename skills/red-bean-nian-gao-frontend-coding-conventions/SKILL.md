---
name: red-bean-nian-gao-frontend-coding-conventions
description: 在 red-bean-nian-gao 中编写、修改、重构或评审 frontend 与 design-system 两个 workspace 的代码，或调整 React 组件、样式、状态管理、导入顺序、注释时使用；给出这两个 workspace 的编码落点，并指向跨仓共享的通用 TypeScript 规则。backend、api-contract、纯 Markdown 或纯配置的改动不使用本 Skill。
---

# red-bean-nian-gao 前端与 Design System 编码规范

> 本 Skill 是 **frontend 与 design-system 两个 workspace** 编码规则的唯一事实来源。
> 通用 TypeScript 规则在 [`references/common.md`](references/common.md)——与 Runtime SDK 仓
> `red-bean-qing-tuan` 中的同名文件**逐字相同**，由 `scripts/check-shared-files.mjs` 校验。
> **两者冲突时以通用件为准**；本文件只写这两个 workspace 特有的约束与落点。
> 后端与 api-contract 的规则见
> [`../red-bean-nian-gao-backend-coding-conventions/SKILL.md`](../red-bean-nian-gao-backend-coding-conventions/SKILL.md)。

**写代码前完整读取两份**：本文件 + [`references/common.md`](references/common.md)。

## 语言与风格

通用规则（类型标注边界、硬性禁止、外部输入、泛型、控制流与错误、函数与流程可读性、表达式与调用
可读性、判空与可空映射、命名与签名约定）全在 [`references/common.md`](references/common.md)。
这两个 workspace 额外强调：

| 场景 | 用什么 |
| --- | --- |
| 组件 Props | `interface` |
| API 响应 / 数据结构 | `interface` |
| 联合类型、工具类型 | `type` |

| 文件类型 | 命名 | 示例 |
| --- | --- | --- |
| 组件 | PascalCase | `ChatInput.tsx` |
| Hook | camelCase，`use` 前缀 | `useAuth.ts` |
| Store | camelCase | `chatStore.ts` |
| 工具函数 | camelCase | `formatTime.ts` |
| 类型文件 | camelCase | `types.ts` |

## 组件

- 一个文件一个组件，**具名导出**（`export function ChatInput`）；文件名与组件名一致。
- 用函数组件，**不用 class 组件**，**不用 `React.FC`**。
- Props 的 `interface` 放组件上方，不内联。
- 参数写具名 `props: XxxProps`，解构放函数体首行；函数体内不使用 `props.xxx`。
- 默认值用解构默认值（`disabled = false`）。
- **禁止 `<div onClick>`**：可交互元素用 `<button>`，否则键盘无法聚焦。
- 事件处理器命名 `handle*`，用 `function` 声明。**多行闭包一律具名并提到组件体内**，不用组件体内
  的 `const` 箭头（见通用规范「函数与流程可读性」）；单行内联回调仍可用箭头函数，超过一行即提升。

```tsx
/**
 * 会话输入框：受控输入 + 提交回调。
 *
 * @param props - 组件属性；字段语义见 `ChatInputProps`。
 */
export function ChatInput(props: ChatInputProps) {
  const { onSubmit, disabled = false, placeholder = '输入消息...' } = props
  const [value, setValue] = useState('')

  function handleSubmit(): void {
    if (value.trim()) {
      onSubmit(value)
      setValue('')
    }
  }

  return (
    <div className="flex gap-2">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 bg-input text-foreground border border-border rounded-md px-3 py-2"
      />
      <button onClick={handleSubmit} disabled={disabled || !value.trim()}>
        发送
      </button>
    </div>
  )
}
```

**导入顺序**固定，用空行分隔三段：第三方库 → `@/` 别名 → 相对路径。

## 样式

**禁止硬编码颜色**，统一用 Tailwind utility + token。ESLint 强制的四条：

| 规则 | 说明 |
| --- | --- |
| 禁止 `#hex` 硬编码 | 必须用 Tailwind utility 或 `var(--color-*)` token |
| 禁止 `rgba()` 硬编码 | 必须用 token |
| 禁止 inline style color / fontSize | 必须用 Tailwind utility |
| Foundations / styles 文件豁免 | 这些文件刻意展示原始值 |

硬编码 utility 的替换对照：

| 禁止 | 替换 |
| --- | --- |
| `style={{ color: ... }}` | `className="text-*"` |
| `style={{ fontSize: ... }}` | `className="text-sm"` 等 |
| `className="bg-white"` | `className="bg-popover"` |
| `className="text-black"` | `className="text-foreground"` |
| `className="border-black"` | `className="border-border"` |
| `className="text-gray-700"` | `className="text-muted-foreground"` |

动态计算的值（如按数据生成的坐标）可以用 inline style，**但颜色和字号不行**。
**CVA 字符串内的硬编码 utility ESLint 检测不到，需人工遵守**——两张表都要对。

## 状态管理

| 场景 | 用什么 | 位置 |
| --- | --- | --- |
| 组件内部状态 | `useState` | 组件内 |
| 复杂组件状态 | `useReducer` | 组件内 |
| 跨页面 / 全局状态 | Zustand | `src/stores/` |
| 服务端缓存 | hooks | `src/hooks/` |

## API 调用与错误处理

**三态原则**：每个数据加载组件必须覆盖 loading / success / error 三种状态。

```tsx
if (loading) return <Skeleton />
if (error) return <ErrorBanner message={error.message} />
return <DataView data={data} />
```

**所有 API 请求与响应必须有类型；HTTP JSON 属于外部输入，先以 `unknown` 读取，再经运行时
guard/decoder 校验。返回类型标注不能替代运行时验证。**

```tsx
import { API_ROUTES } from '@red-bean/api-contract'   // 路径只从这里来，不手写字面量

async function fetchSessions(): Promise<SessionListResponse> {
  return apiCall(API_ROUTES.SESSIONS.path, {}, (value) =>
    decodeEnvelopeData(value, isSessionListResponse, 'session list')
  )
}
```

禁止 `return (await res.json()) as ResponseType`、泛型 `res.json<ResponseType>()` 等只改变静态类型、
不验证运行时结构的写法。共享 guard/decoder 位于 `src/services/api/response-validation.ts`。

前端**不得**从后端源码导入 DTO，也不得复制共享 wire 类型；一律从 `@red-bean/api-contract` 取。

## 性能（AI 默认不做，review 时检查）

AI 生成的代码默认不做性能优化（`memo`、`lazy`），避免过度优化。出现以下情况再优化：

- 列表超过 50 项 → 考虑虚拟滚动
- 父组件频繁渲染导致子组件卡顿 → 加 `memo`
- 初始加载 JS 包过大 → `lazy` 拆分路由

正常情况下不需要 `useMemo` / `useCallback`。

## 注释

注释的唯一事实来源是 [`references/common.md`](references/common.md) 的「注释」章节。这两个 workspace 额外强调：

- **Props 注释即对外 API 文档**：关键 Props 用 JSDoc 说明用途与边界——回调触发时机、`undefined`
  与缺省语义、联动的前置条件。组件被前端经 alias 跨项目消费，改 Props 必须同 diff 更新注释。
- **组件签名**：参数写具名 `props`、解构放函数体首行——门禁要求参数是简单标识符才能写 `@param`。
- **文件头职责注释**：design-system 每个组件文件头标明角色（原子件 / 复合件 / 内部件）与消费场景；
  内部件必须标注「内部件」。
- **视觉与交互决策注释 why**：开合状态保留、兼容旧调用方映射、动效偏好等反直觉行为必须写原因——
  组件注释是前端开发者唯一的本地文档。
- **hooks / store action / SSE 事件处理**：跨状态流转的意图注释；方法流程超过三步用
  `// ── 阶段名 ──` 分段标题。
- **三态节点**：loading / success / error 分支点注明展示语义。
- **测试**：setup/mock 的目的、故障注入与断言原因用中文；用例名允许英文描述风格。
- 注释语言的机械门禁由 `make ts-export-jsdoc-check` 负责（描述正文必须含中文字符）；专有协议名、
  URL 与 TS 指令保留原文。

## Design System 组件

**入册规则（防漂移）**：

1. design-system **只收前端可直接 import 的组件**（原子件 + 共享复合件），每个组件必须有真实的前端
   消费方（或当次需求即将接入）。
2. **禁止「模仿前端页面结构」的拷贝式场景页**。连接路由、Store 或 API 的页面级业务容器（如
   `TaskDetailPanel`）留在 frontend；可被多个页面直接消费、无业务依赖的纯展示复合件（如
   `ScheduledTaskOverview`）可以入册。Showcase 必须直接渲染真实组件，**不能手写视觉副本**。
3. **禁止「先做组件等前端用」**——没有消费方的组件不入册。
4. **内部件**（如 `ToolItem`）：仅被其他组件内部依赖，不单独出 showcase 页，不对外承诺 API，
   文件头注释标注「内部件」。

**组件内部**：import 用相对路径（`./ToolItem`），**不用 `@/components/retroui/...`**——前端通过
Vite alias 加载时 `@/` 上下文不同。只有 showcase / foundations / app 层可用 `@/` alias。
组件必须 self-contained：不依赖 showcase 或 app 层代码。

**Showcase 页面**：每个组件必须有展示页，且按适用性覆盖——

| 状态 | 说明 |
| --- | --- |
| Default | 组件默认外观 |
| Variants | 所有 variant / size 组合 |
| Hover / Focus-visible | 悬停与键盘焦点态 |
| Disabled | 禁用态 |
| Loading / Streaming | 流式或加载中状态 |
| Empty | 空数据状态 |
| Error / Success | 失败与成功状态 |
| 长文本 | 超长内容的换行与截断 |
| 360px 宽度 | 窄视口下的布局与触控目标 |

示例数据必须虚构：账户统一使用「张三 / `san.zhang` / `san.zhang@example.com`」，不得出现开发者
真实身份。展示页模板参考现有 `ButtonsActionsPage.tsx`、`InputPage.tsx` 等。

新增组件时的清单：

- [ ] 组件文件在 `src/components/`
- [ ] Showcase 页在 `src/showcase/`
- [ ] Tab ID 注册到 `tabs.ts`
- [ ] Page 注册到 `App.tsx` 的 `PAGES` 映射
- [ ] 启动 dev server 目视确认
- [ ] 有交互行为时已补测试
- [ ] `pnpm ai:check` 通过

## Token 架构（三层级）

CSS 变量遵循 **Primitive → Semantic → Component** 三层，定义在
`design-system/src/styles/design-tokens.css`（**单一真实来源**，前端只 `@import`，不复制第二份）：

- **Primitive**：原始色值（如 `--color-bean-light: #99413C`）
- **Semantic**：按用途命名，由 light / dark 主题映射（如 `--action-confirm`、`--success`）
- **Component**：组件级组合（`--button-default-bg: var(--primary)`）

颜色角色必须完整记录在 Color foundation 与 `philosophyMarkdown.ts`：文字、indicator、selection、
focus、surface、普通边框和控件边框**不得合并成一个泛化 token**。状态文字使用 `--success-text` /
`--danger-text`，图标与节点使用 `--success-indicator` / `--danger-indicator`；兼容别名 `--success` /
`--danger` 只代表文字色。

Light / Dark 只能替换语义 token；DOM 结构、信息层级和交互必须保持一致——同一组件在两个主题下是
**同一份实现，不是两份**。

## 与 Design System 的边界

- **产品视觉规范（色值、布局与响应式、图标、交互与无障碍、系统状态）的唯一事实来源是
  [`../red-bean-nian-gao-visual-language/SKILL.md`](../red-bean-nian-gao-visual-language/SKILL.md)**；
  组件怎么进册、怎么验收见 [`../../design-system/AGENTS.md`](../../design-system/AGENTS.md)；
  本节只补充与通用代码规则接壤的部分。
- **共享 UI 组件与 token 的变更从 design-system 开始**，经人工确认后再进入 frontend。前端通过
  Vite alias 直接引用 `design-system/src/components`，**不复制第二份**，也不在前端创建本地 UI 基础
  组件。流程见
  [`../red-bean-nian-gao-development-workflow/SKILL.md`](../red-bean-nian-gao-development-workflow/SKILL.md)「UI 变更：mock 先行」。
- 页面路由、数据请求、Store 与业务容器留在 frontend；只有可被多个页面直接消费、无业务依赖的纯展示
  复合件才入册 design-system。

## 门禁

**本仓门禁命令的唯一清单在根 [`AGENTS.md`](../../AGENTS.md)「门禁」**——`make verify` 覆盖全部
四个 workspace。这两个 workspace 自己的检查：

```bash
pnpm format:check   # Prettier 格式检查（只读）
pnpm format         # Prettier 格式修复（会写文件）
pnpm typecheck      # tsc --noEmit
pnpm lint           # ESLint
pnpm test           # Vitest
pnpm build          # 生产构建
```

design-system 另有 `pnpm ai:check`（lint + format:check + typecheck + test + build + drift）。
