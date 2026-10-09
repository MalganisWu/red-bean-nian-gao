# red-bean-nian-gao Frontend

AI Agent 对话平台前端，提供流式对话、工具/子 Agent 过程展示、询问卡片、会话历史和定时任务。
视觉语言使用 Light / Dark 对等的 Quiet Tool UI。

## 技术栈

- React 19、TypeScript、Vite 8、Tailwind CSS 4
- React Router 7、Zustand、Base UI
- `@microsoft/fetch-event-source` 消费 POST SSE
- Vitest + Testing Library

基础 UI 组件不在本目录复制维护。`@/components/retroui/*` 通过 Vite/TypeScript alias
直接指向 `../design-system/src/components/*`，Design System 是组件与 token 的唯一来源。

## 本地运行

要求 Node.js >=24.9.0、<26 与 pnpm 11.x（项目声明并推荐 11.5.2）。先按根
[README](../README.md) 启动后端和基础设施，然后：

```bash
pnpm install --frozen-lockfile  # 仓库根执行：workspace 单 lockfile 全仓安装
pnpm --filter frontend dev
```

开发服务器运行在 <http://localhost:5173>，并把 `/api`、`/health`、`/readyz`、`/version`
代理到 <http://localhost:8080>。

## 质量门禁

```bash
pnpm --filter frontend typecheck
pnpm --filter frontend lint
pnpm --filter frontend format:check
pnpm --filter frontend test
pnpm --filter frontend build
pnpm --filter frontend check:drift
```

格式不通过时从仓库根运行 `pnpm --filter frontend format` 修复。前端与 Design System 共用仓库根 `.prettierrc`，但各自在自己的
package 中声明并锁定 Prettier，避免依赖另一个 package 的 `node_modules`。

也可在仓库根目录运行 `make verify`。发布前使用 `make verify-full`。

API、错误码和 SSE wire payload 的唯一事实来源是
[docs/contracts/api.md](../docs/contracts/api.md)。契约测试会核对服务调用、路径常量、正式事件集合、
canonical payload 和运行时守卫。推理事件统一为 `reason`；旧 `think` 事件已随存量兼容清理删除，
契约测试不再放行。

## 目录

```text
src/
├── app/          # 应用入口与路由
├── components/   # 对话、任务与布局业务组件
├── hooks/        # SSE 等 React hooks
├── services/     # HTTP / SSE 客户端
├── stores/       # Zustand 状态
├── types/        # API、事件与展示类型
├── styles/       # 全局样式；token 从 design-system 导入
└── lib/          # 常量与纯工具
```

开发规则见 [AGENTS.md](AGENTS.md) 和 [前端开发流程](docs/standards/development-workflow.md)。
