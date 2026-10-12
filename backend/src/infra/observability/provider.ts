import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources'
import { tracing } from '@opentelemetry/sdk-node'
import type { TracerPort } from '../../shared/observability/tracer.js'

import { OTelTracer, PreferredTraceIdGenerator } from './otel-tracer.js'
import { StructuredLogTracer, type StructuredLogSink } from './structured-log-tracer.js'

const INSTRUMENTATION_NAME = 'red-bean-nian-gao'

export interface ObservabilityProviderOptions {
  readonly exporter: string
  readonly serviceName: string
  readonly environment: string
  readonly sampleRatio: number
}

export interface ObservabilityProviderDependencies {
  readonly exporterFactory?: (() => tracing.SpanExporter) | undefined
  readonly logSink?: StructuredLogSink | undefined
}

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

  public shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#shutdown?.() ?? Promise.resolve()
    return this.#shutdownPromise
  }
}

/** 按配置构造产品 tracing 后端，同时避免 OTel 类型泄漏到业务代码。 */
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
