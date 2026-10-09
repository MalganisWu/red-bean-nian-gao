# CLAUDE.md

Claude Code 的项目路由入口。本文件不维护项目规范；根目录及目标路径沿途的
`AGENTS.md` 是唯一事实来源。

## 每次任务开始前

1. 完整读取根目录 [`AGENTS.md`](../AGENTS.md)。
2. 按其中的路由，完整读取目标路径适用的模块级 `AGENTS.md` 及其直接要求的文档。
3. 任务匹配 `.claude/skills/` 中的专项工作流时再加载对应 Skill；Skill 不能替代
   `AGENTS.md`，出现冲突时以目标路径最近的 `AGENTS.md` 为准。
