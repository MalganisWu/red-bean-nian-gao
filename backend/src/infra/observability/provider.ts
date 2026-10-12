import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import { tracing } from '@opentelemetry/sdk-node'
import type { TracerPort } from '../../shared/observability/tracer.js'

import { OTelTracer, PreferredTraceIdGenerator } from './otel-tracer.js'
import { StructuredLogTracer, type StructuredLogSink } from './structured-log-tracer.js'

const INSTRUMENTATION_NAME = 'red-bean-nian-gao'

/** 观测后端配置；来自 `config.observability`，`exporter` 只认 structured 与 otlp。 */
export interface ObservabilityProviderOptions {
  readonly exporter: string
  readonly serviceName: string
  readonly environment: string
  readonly sampleRatio: number
}

/** 构造依赖；两处均可注入，测试因此不建真实 exporter、也不去抓 stdout。 */
export interface ObservabilityProviderDependencies {
  readonly exporterFactory?: (() => tracing.SpanExporter) | undefined
  readonly logSink?: StructuredLogSink | undefined
}

/** 观测后端的持有者：业务只见 `TracerPort`，Provider 关闭时负责把在途 span 刷出去。 */
export class ObservabilityProvider {
  readonly #tracer: TracerPort
  readonly #shutdown: (() => Promise<void>) | undefined
  #shutdownPromise: Promise<void> | undefined

  public constructor(tracer: TracerPort, shutdown?: () => Promise<void>) {
    this.#tracer = tracer
    this.#shutdown = shutdown
  }

  public tracer(): TracerPort {
    return this.#tracer
  }

  /** 幂等：并发或重复关闭共享同一次 shutdown，不会重复刷两次 exporter。 */
  public shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown?.() ?? Promise.resolve()
    return this.#shutdownPromise
  }
}

/**
 * 按配置构造产品 tracing 后端，同时避免 OTel 类型泄漏到业务代码。
 *
 * 两种模式：
 * - `structured`（默认）：零依赖的结构化日志，不建任何网络连接，适合本地与轻量部署。
 * - `otlp`：建 SDK Provider，配 `ParentBased(TraceIdRatioBased)` 采样与 BatchSpanProcessor。
 *   采样是父级优先的——上游决定采样时本地跟随，只有根 span 才按 `sampleRatio` 掷骰子。
 *   这样一条已经开始的链路不会在中途因为某个服务的采样率而断掉。
 */
export function createObservabilityProvider(
  options: ObservabilityProviderOptions,
  dependencies: ObservabilityProviderDependencies = {}
): ObservabilityProvider {
  const exporterName = options.exporter.trim().toLowerCase() || 'structured'
  const serviceName = options.serviceName.trim()
  if (serviceName === '') throw new Error('create trace provider: service name must not be empty')
  if (options.sampleRatio <= 0 || options.sampleRatio > 1) {
    throw new Error('create trace provider: sample ratio must be in (0, 1]')
  }

  if (exporterName === 'structured') {
    return new ObservabilityProvider(new StructuredLogTracer({ sink: dependencies.logSink }))
  }
  if (exporterName !== 'otlp') {
    throw new Error(
      `create trace provider: unsupported exporter ${JSON.stringify(options.exporter)}`
    )
  }

  const exporter = dependencies.exporterFactory?.() ?? new OTLPTraceExporter()
  const resourceAttributes: Record<string, string> = { 'service.name': serviceName }
  const environment = options.environment.trim()
  if (environment !== '') resourceAttributes['deployment.environment.name'] = environment
  const resource = defaultResource().merge(resourceFromAttributes(resourceAttributes))
  const idGenerator = new PreferredTraceIdGenerator()
  const sdkProvider = new tracing.BasicTracerProvider({
    idGenerator,
    resource,
    sampler: new tracing.ParentBasedSampler({
      root: new tracing.TraceIdRatioBasedSampler(options.sampleRatio),
    }),
    spanProcessors: [new tracing.BatchSpanProcessor(exporter)],
  })
  return new ObservabilityProvider(
    new OTelTracer(sdkProvider.getTracer(INSTRUMENTATION_NAME), idGenerator),
    (): Promise<void> => sdkProvider.shutdown()
  )
}
