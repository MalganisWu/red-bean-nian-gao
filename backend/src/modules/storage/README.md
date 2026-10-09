# Storage Module

负责用户文件的上传、下载、删除和预签名。模块顶层分为 `controller/`（HTTP）与 `service/`（业务）
平级两大块。路由与 Controller 分离，Controller 直接依赖 `StorageService`（内部 1:1 实现类，无独立
Port）；`StorageService` 承担对象 key 与所有权规则，`storage.module.ts` 选择 `MinioObjectStorage`
Adapter 并负责启动时创建 Bucket。

## 阅读入口

```text
http-api.ts
→ controller/storage.routes.ts
→ controller/storage.controller.ts
→ service/application/storage-service.ts
→ service/application/model/object-result.ts
→ service/object-storage/object-storage.ts
→ service/object-storage/minio-object-storage.ts
→ storage.module.ts
```

HTTP DTO 只存在于 `controller/`，对象 key 和用户归属属于 Application Service，MinIO 请求与响应流只存在于
Object Storage Adapter。下载流由 HTTP 调用方消费；取消与失败时 Adapter 负责关闭底层资源。
`ObjectInfo` 与 `ObjectDownload` 是稳定的应用结果，位于 `service/application/model/object-result.ts`；入站
`StorageService` 与出站 `ObjectStorage` 都依赖该模型，应用层不再从私有 ObjectStorage Port 反向取类型。

`storage.module.ts` 完成本模块实现与边界绑定；`AuthServicePort` 由 Identity Module 创建并在
`app/composition-root.ts` 注入。跨 Module 只能从 `public-api.ts` 使用 `StorageModule`；`StorageService`
为模块内部实现类，不对外暴露。应用健康检查通过 `StorageHealthPort`（保留的真边界，composition root
直接调用）接入，Module 不向外暴露内部 `ObjectStorage` Port。

`StorageHealthPort` 由 `storage.module.ts` 使用同一私有 `ObjectStorage` 实例组装，并由 composition root
接入 readiness。探测会传播存储连通性、权限与取消错误；它不接管或关闭底层客户端，资源生命周期仍归
Storage Module 所有。

HTTP、Application Service 与对象所有权规则由
`test/modules/storage/controller/storage-routes.test.ts` 组合验证；真实 MinIO 的上传、读取、预签名和删除由
`test/integration/redis-minio.integration.test.ts` 覆盖。
