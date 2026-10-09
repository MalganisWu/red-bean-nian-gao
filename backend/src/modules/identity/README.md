# Identity Module

负责注册、登录、Token 刷新、当前用户资料和用户查询；不负责 HTTP 公共错误格式或其他模块的授权规则。

## 阅读入口

```text
http-api.ts
→ controller/identity.routes.ts
→ controller/identity.controller.ts
→ service/application/{registration,profile}/          （内部 1:1 实现类，无独立 Port）
→ service/authentication/port + service/user-repository/port    （真边界）
→ identity.module.ts
```

Controller 分别依赖注册与资料查询的实现类以及认证真边界 `AuthServicePort`，用例流程可在单个
Controller 方法与 Service 公开方法内完整读完。`AuthServicePort` 是 HTTP 鉴权及其他 Module 共用的
认证边界。`identity.module.ts` 将 `UserRepository`、`PasswordHasher`、`AuthServicePort` 分别绑定到
`PostgresUserRepository`、`BcryptPasswordHasher` 和 `JwtAuthService`，再显式创建两个应用 Service。
模块顶层分为 `controller/`（HTTP）与 `service/`（业务）平级两大块，业务内部按子域平铺：
接口集中在各子域的 `port/` 目录，实现类直接放在子域目录下。

注册的用户名、邮箱唯一性最终由数据库约束保证，并统一映射为业务冲突；密码明文只停留在请求与散列调用
期间。跨 Module 只能从 `public-api.ts` 使用认证 Port，不能导入用户仓储或 Controller。
`IdentityModule` 不返回 `UserRepository`；共享 HTTP 认证只依赖 `shared/authentication` 定义的最小
`TokenValidator`。`AuthServicePort` 显式扩展该边界，默认 `JwtAuthService` 的绑定不依赖结构类型巧合。

对应测试位于 `test/modules/identity/{controller,service/application,service/authentication,service/user-repository}/`。
