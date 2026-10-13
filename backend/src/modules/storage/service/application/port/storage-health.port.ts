/**
 * Storage Module 拥有的对象存储就绪检查边界。
 *
 * 默认实现为 `StorageHealthService`，由 `storage.module.ts` 使用该模块私有的 `ObjectStorage`
 * 实例组装；`app/composition-root.ts` 只把本 Port 接入应用 readiness，不接触底层存储客户端。
 * `check` 必须传播连通性、权限及对象存储响应错误，并遵守传入的 `AbortSignal`；本 Port 不创建、关闭
 * 或转移存储客户端所有权，底层资源生命周期始终由 Storage Module 管理。
 */
export interface StorageHealthPort {
  /**
   * 探测当前对象存储是否可用；失败或取消时 reject，不把异常折叠为布尔值。
   *
   * @param signal - 由健康检查调用方提供的取消信号，超时或关停时中断探测
   */
  check(signal: AbortSignal): Promise<void>
}
