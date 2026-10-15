/**
 * 会话事实日志的持久化校验错误：facts 或 run 行在信任边界校验失败时抛出。
 * 调用方（如轨迹读取端）据此决定降级策略；基础设施故障不应使用本错误。
 */
export const RUN_FACT_STORE_ERROR_CODES = Object.freeze({
  // facts 内容或 run 行形状不可读（历史脏数据 / 未来版本记录）。
  FACTS_UNREADABLE: 'run_fact_facts_unreadable',
} as const)

/** 持久化校验错误码的字面量联合。 */
export type RunFactStoreErrorCode =
  (typeof RUN_FACT_STORE_ERROR_CODES)[keyof typeof RUN_FACT_STORE_ERROR_CODES]

/** facts / run 行的校验失败；只用于信任边界上的「读不懂」，基础设施故障不要套用这个类型。 */
export class RunFactStoreError extends Error {
  /** 校验失败码；调用方据此区分「读不懂记录」与基础设施故障。 */
  public readonly code: RunFactStoreErrorCode

  public constructor(code: RunFactStoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RunFactStoreError'
    this.code = code
  }
}
