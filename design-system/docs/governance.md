# 设计系统治理

Quiet Tool UI 是 red-bean-nian-gao 的唯一视觉规范。本文定义规范、组件与正式前端之间的责任边界，避免展示站与产品实现再次漂移。

## 单一事实来源

- 颜色、字体、间距、圆角、阴影和动效 token 以 `src/styles/design-tokens.css` 为准。
- 可复用且被正式前端消费的 UI 组件以 `src/components/` 为准。
- Showcase 必须直接渲染真实组件，不复制一份外观相似的静态结构。
- 页面路由、数据请求、Store 与业务容器留在 `frontend/`；设计系统只记录可复用模式和状态契约。
- Preview 是待审核方案，不是正式规范。只有用户确认后，才能同步至组件、Showcase 和前端。

## 变更分级

| 变更类型 | 处理方式 |
|---|---|
| 新增缺失文档、状态清单、语义说明 | 可直接补充，并在提交中注明来源 |
| 修正文案与现有实现不一致 | 按当前已确认实现修正，不改变视觉 |
| 调整颜色、圆角、字体、间距、层级或交互 | 先创建独立 Preview，经人工确认后同步 |
| 新建或修改共享组件 | 组件与 Showcase 同步更新，再验证正式前端 |
| 删除组件或公开 variant | 先核对正式消费方，记录迁移方案后执行 |

## 组件生命周期

1. `proposal`：仅存在于 `previews/`，可比较多个候选，不对前端承诺。
2. `accepted`：方案已人工确认，token 和交互口径已冻结。
3. `implemented`：真实组件、Showcase 与正式消费方一致。
4. `deprecated`：已标出替代方案和移除窗口，不再新增消费方。
5. `removed`：无正式引用、无文档残留，并通过漂移检查。

## 入册与验收

- 每个公开组件必须有至少一个正式消费方和一个 Showcase。
- Showcase 按适用性覆盖 default、hover、focus-visible、disabled、loading、empty、error、success、长文本和 360px 宽度。
- Light / Dark 只能替换语义 token，DOM 结构、信息层级和交互保持一致。
- 状态不能只靠颜色表达；至少同时提供文字、图标或形状差异。
- 示例数据必须虚构。账户统一使用“张三 / san.zhang / san.zhang@example.com”，不得出现开发者真实身份。
- 合并前运行 `pnpm ai:check`，正式前端运行 lint、typecheck、test、build 与 drift check。

## 评审记录

影响现有视觉的提案必须在提交或计划文档中记录：问题证据、Preview 地址、确认结果、受影响组件、迁移范围和验证结果。没有确认记录的 Preview 不得被视为正式规范。
