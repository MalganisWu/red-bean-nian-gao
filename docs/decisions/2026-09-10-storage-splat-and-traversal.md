# 决策：storage 下载/删除路由保留 splat 通配，`..` 段校验作为纵深防御

状态：已接受
日期：2026-09-10

背景：对象 key 按路径组织（`uploads/{userId}/{timestamp}.ext`），含多级斜杠；Fastify `:param`
匹配不到 `/`，编码整段 key（`%2F`）在反代层有已知坑且 URL 不可读。目录曾用自创记法 `*key`
描述该路由，与真实注册的 `*` 不一致。

选项：
- 保留通配 `*`（S3 风格 path 直通）。
- 下载改走 query 传 key（`GET /download?key=...`），消灭通配形态。
- key 扁平化（无斜杠单段），`:key` 即可承载。

决策：保留 `*`（目录归一为 Fastify 原生记法）。理由是外部客户端直连 MinIO 的路径式直链
是预期方向，query 形态届时还要改回来；key 扁平化需要迁移存量对象，不值。`objectPathSchema`
收紧为 key 非空且不含 `..` 段。

后果：
- 路由模板含 `*` 特殊语义，边界行为由契约测试锁定：含斜杠 key 完整透传（200）、
  `/download/` 空 splat 被 schema 拒绝（400）、无尾斜杠 404。
- 实证：`..` 段（含 `%2E%2E`）在 Fastify 路由匹配前即被解码归一化（404），schema 的 `..`
  拒绝只能通过绕过路由直接调用 `parseObjectPath` 触发——属纵深防御，行为由契约测试直接覆盖。
- `pathWithSuffix`（前端拼 key 的共享工具）暂不实现，等 storage 直链出现真实调用方。