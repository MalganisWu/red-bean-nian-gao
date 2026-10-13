# 前端编码规范

> 本文只补充 React/UI 规则。通用 TypeScript 类型、安全、可读性、泛型和门禁规则以跨仓共享的
> [`../../../docs/standards/typescript-common-conventions.md`](../../../docs/standards/typescript-common-conventions.md)
> 为唯一事实来源；产品仓特有约束见
> [`../../../docs/standards/typescript-coding-conventions.md`](../../../docs/standards/typescript-coding-conventions.md)。

---

## 1. TypeScript 严格模式

**硬性规则**：继承全仓严格 TypeScript 配置，禁止隐式或显式 `any`。

```tsx
// ✅ 正确：明确类型
function formatMessage(content: string, timestamp: number): string {
  return `${timestamp}: ${content}`
}

// ❌ 错误：无类型，人和 AI 都看不懂用途
function formatMessage(content, timestamp) {
  return `${timestamp}: ${content}`
}

// ❌ 错误：显式 any；未知输入必须从 unknown 开始窄化
function handle(data: any) { ... }
```

**导出函数与跨模块边界必须标注返回类型**；简单局部回调和类型已经完整约束的组件允许推导：

```tsx
// ✅ 正确：返回类型一目了然
function useAuth(): { user: User | null; login: (token: string) => void } { ... }

// ❌ 错误：看代码要跳到实现才知道返回什么
function useAuth() { ... }
```

**interface vs type**：

| 场景 | 用什么 |
|------|--------|
| 组件 Props | `interface` |
| API 响应 / 数据结构 | `interface` |
| 联合类型、工具类型 | `type` |

---

## 2. 组件规范

### 文件约定

- 一个文件一个组件，默认导出
- 文件名与组件名一致（PascalCase）：`ChatInput.tsx`、`MessageList.tsx`
- 子组件放同目录或 `components/` 子目录

### 组件内部结构

```tsx
// 1. import
import { useState } from 'react'
import type { FC } from 'react'

// 2. Props interface
interface ChatInputProps {
  onSubmit: (message: string) => void
  disabled?: boolean
  placeholder?: string
}

// 3. 组件定义（参数具名 props，解构放函数体首行 —— 导出组件的 JSDoc 门禁要求参数是
//    简单标识符才能写 @param；函数体内仍不使用 props.xxx）
export function ChatInput(props: ChatInputProps) {
  const { onSubmit, disabled = false, placeholder = '输入消息...' } = props

  // 4. hooks
  const [value, setValue] = useState('')

  // 5. 事件处理（多行闭包一律具名；用 function 声明，不用组件体内 const 箭头）
  function handleSubmit(): void {
    if (value.trim()) {
      onSubmit(value)
      setValue('')
    }
  }

  // 6. JSX
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

**规则速查**：

| 规则 | 说明 |
|------|------|
| Props 用 `interface` | 放组件上方，不内联 |
| 函数组件 | 不用 class 组件 |
| Props 具名参数 | 参数写 `props: XxxProps`，解构放函数体首行；函数体内不用 `props.xxx` |
| 默认值用解构默认值 | `disabled = false` |
| 不用 `React.FC` | 直接用函数类型 |
| 禁止 `<div onClick>` | 可交互元素用 `<button>`（支持键盘聚焦） |
| 事件处理器命名 `handle*` | `handleSubmit`、`handleChange` |
| 事件处理器用 `function` 声明 | 多行闭包一律具名，不用组件体内 `const` 箭头（见通用规范「函数与流程可读性」） |
| 单行内联回调可以用箭头函数 | 如 `onChange={(e) => setValue(e.target.value)}`；超过一行即提到组件体内 |

---

## 3. 样式规范

**核心原则**：禁止硬编码颜色，统一用 Tailwind utility + token。

```tsx
// ✅ 正确：Tailwind utility
<div className="bg-card text-foreground border border-border rounded-lg p-4">

// ❌ 错误：硬编码颜色
<div style={{ backgroundColor: '#1E2025', color: '#EDE9E0' }}>
```

| 禁止 | 替换 |
|------|------|
| `style={{ color: ... }}` | `className="text-*"` |
| `style={{ fontSize: ... }}` | `className="text-sm"` 等 |
| `className="bg-white"` | `className="bg-popover"` |
| `className="text-black"` | `className="text-foreground"` |
| `className="border-black"` | `className="border-border"` |

**例外**：动态计算的值（如根据数据生成的坐标）可以用 inline style，但颜色和字号不行。

---

## 4. 状态管理

| 场景 | 用什么 | 位置 |
|------|--------|------|
| 组件内部状态 | `useState` | 组件内 |
| 复杂组件状态 | `useReducer` | 组件内 |
| 跨页面/全局状态 | Zustand | `src/stores/` |
| 服务端缓存 | hooks | `src/hooks/` |

---

## 5. 导入顺序

固定顺序，空行分隔：

```tsx
// 1. 第三方库
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

// 2. @/ 别名（项目内部绝对路径）
import { Button } from '@/components/retroui/Button'
import { useAuth } from '@/hooks/useAuth'

// 3. 相对路径
import { MessageBubble } from './MessageBubble'
import { formatTime } from '../lib/time'
```

---

## 6. API 调用与错误处理

**三态原则**：每个数据加载组件必须覆盖 loading / success / error 三种状态。

```tsx
// ✅ 正确：显式三态
if (loading) return <Skeleton />
if (error) return <ErrorBanner message={error.message} />
return <DataView data={data} />
```

**API 类型定义**：所有 API 请求/响应必须有类型。HTTP JSON 属于外部输入，必须先以 `unknown`
读取，再通过运行时 guard/decoder 校验；返回类型标注不能替代运行时验证。

```tsx
import { apiCall } from './client'
import { decodeEnvelopeData, isSessionListResponse } from './response-validation'

// ✅ 正确：apiCall 读取 unknown，decoder 验证成功信封与业务数据后再返回可信类型
async function fetchSessions(): Promise<SessionListResponse> {
  return apiCall('/api/sessions', {}, (value) =>
    decodeEnvelopeData(value, isSessionListResponse, 'session list')
  )
}
```

禁止 `return (await res.json()) as ResponseType`、泛型 `res.json<ResponseType>()` 或其他只改变静态类型、
没有验证运行时结构的写法。共享 guard/decoder 位于 `src/services/api/response-validation.ts`。

---

## 7. 文件命名

| 类型 | 命名 | 示例 |
|------|------|------|
| 组件 | PascalCase | `ChatInput.tsx` |
| Hook | camelCase，`use` 前缀 | `useAuth.ts` |
| Store | camelCase | `chatStore.ts` |
| 工具函数 | camelCase | `formatTime.ts` |
| 类型文件 | camelCase | `types.ts` |

---

## 8. 性能（AI 默认不做，review 时检查）

AI 生成的代码默认不做性能优化（memo、lazy），避免过度优化。审查时如果出现以下情况再优化：

- 列表超过 50 项 → 考虑虚拟滚动
- 父组件频繁渲染导致子组件卡顿 → 加 `memo`
- 初始加载 JS 包过大 → `lazy` 拆分路由

正常情况下不需要 `useMemo` / `useCallback`。

---

## 9. 注释规范（前端补充）

规则正文见根 [`typescript-common-conventions.md`「中文注释」](../../../docs/standards/typescript-common-conventions.md)
（简体中文、讲 why 与边界、注释与代码同 diff 更新、测试注释优先中文）。本节只列 React/UI 场景的应用要点：

- **Props**：关键 Props 用 JSDoc 说明用途与边界——回调触发时机、`undefined` 与缺省语义、联动的前置条件
- **hooks / store action / SSE 事件处理**：跨状态流转的意图注释；方法流程超过三步用 `// ── 阶段名 ──`
  分段标题，让执行顺序成为视觉事实
- **测试**：setup/mock 的目的、故障注入与断言原因用中文注释；用例名允许英文描述风格
- **三态节点**：loading / success / error 分支点注明展示语义，与页面验收「三态原则」对应
- 注释语言不做机械门禁（协议名、URL、TS 指令等会被误报），由 review 与交付前人工扫描负责；发现
  英文残留注释属于缺陷而非风格偏好，应随改动一并清理

---

## 工具链

```bash
pnpm format:check # Prettier 格式检查（只读）
pnpm format       # Prettier 格式修复（会写文件）
pnpm typecheck    # tsc --noEmit
pnpm lint         # ESLint
pnpm build        # 生产构建
```
