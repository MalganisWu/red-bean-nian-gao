/*
 * 产品侧的中性观测 Port。与 Runtime SDK 的同名契约同形但**独立定义**：
 * 业务代码依赖这一个，SDK 类型只在 Runtime Adapter 边界做映射，
 * 因此换观测后端（结构化日志 ↔ OTLP）不会波及任何业务模块。
 */
/** 产品宿主使用的中性 Trace 属性。 */
export interface TraceAttribute {
  readonly key: string
  readonly value: string
}

/** span 的窄接口；`within` 把本 span 设为异步上下文里的活跃 span，子 span 才会挂在它下面。 */
export interface TraceSpan {
  setAttributes(...attributes: readonly TraceAttribute[]): void
  within<TValue>(operation: () => Promise<TValue>): Promise<TValue>
  end(error?: Error): void
}

/** 造 span 的入口；业务只依赖它，不感知底层是结构化日志还是 OTLP。 */
export interface TracerPort {
  start(start: { readonly name: string; readonly attributes: readonly TraceAttribute[] }): TraceSpan
}

/**
 * 不做任何事的 Tracer。
 * 存在的意义是**让「没配观测」和「配了观测」在业务代码里长得一样**：
 * 调用方永远拿到一个可用的 TracerPort，不必到处判空，也不会因为忘记判空而崩。
 * `within` 仍然执行操作——它只是不传播上下文，不能顺手把业务逻辑吞掉。
 */
export class NoopTraceSpan implements TraceSpan {
  public setAttributes(): void {}
  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return operation()
  }
  public end(): void {}
}

/** 空实现；`start` 恒返回 `NoopTraceSpan`，让「没配观测」与「配了观测」在业务代码里长得一样。 */
export class NoopTracer implements TracerPort {
  public start(): TraceSpan {
    return new NoopTraceSpan()
  }
}
