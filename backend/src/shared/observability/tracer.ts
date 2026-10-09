/** 产品宿主使用的中性 Trace 属性。 */
export interface TraceAttribute {
  readonly key: string
  readonly value: string
}

export interface TraceSpan {
  setAttributes(...attributes: readonly TraceAttribute[]): void
  within<TValue>(operation: () => Promise<TValue>): Promise<TValue>
  end(error?: Error): void
}

export interface TracerPort {
  start(start: { readonly name: string; readonly attributes: readonly TraceAttribute[] }): TraceSpan
}

export class NoopTraceSpan implements TraceSpan {
  public setAttributes(): void {}
  public within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
    return operation()
  }
  public end(): void {}
}

export class NoopTracer implements TracerPort {
  public start(): TraceSpan {
    return new NoopTraceSpan()
  }
}
