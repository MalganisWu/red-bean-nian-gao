import { randomBytes } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

import multipart from '@fastify/multipart'
import fastify, {
  LogController,
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
  type preHandlerAsyncHookHandler,
} from 'fastify'
import { normalizeError } from '../errors/normalize-error.js'
import type { IdGenerator } from '../id/id-generator.js'
import { NoopTracer, type TraceSpan, type TracerPort } from '../observability/tracer.js'

import {
  AppError,
  errorResponse,
  loggedInternalError,
  notFoundError,
  payloadTooLargeError,
  rateLimitError,
} from './error-mapper.js'

const DEFAULT_JSON_BODY_LIMIT = 1 << 20
const DEFAULT_RATE_LIMIT_WINDOW_MILLISECONDS = 60_000
const REQUEST_ID_HEADER = 'x-request-id'
const TRACE_ID_HEADER = 'x-trace-id'

export interface ExtractedTraceContext {
  readonly traceId: string
  readonly parentSpanId: string
  readonly traceFlags?: number | undefined
  readonly traceState?: string | undefined
}

/** 外部 trace header 的解析端口；默认实现为 `W3CTraceContextExtractor`。 */
export interface TraceContextExtractorPort {
  extract(headers: IncomingHttpHeaders): ExtractedTraceContext | undefined
}

export interface HttpServerOptions {
  readonly idGenerator: IdGenerator
  readonly corsOrigins?: string | undefined
  readonly jsonBodyLimit?: number | undefined
  readonly logger?: FastifyServerOptions['logger'] | undefined
  readonly tracer?: TracerPort | undefined
  readonly traceIdGenerator?: (() => string) | undefined
  readonly traceContextExtractor?: TraceContextExtractorPort | undefined
}

interface FixedWindowEntry {
  count: number
  windowStartedAt: number
}

export interface FixedWindowRateLimiterOptions {
  readonly limit: number
  readonly windowMilliseconds: number
  readonly now?: (() => number) | undefined
}

interface RateLimitDecision {
  readonly allowed: boolean
  readonly retryAfterSeconds: number
}

const requestTraceIds = new WeakMap<FastifyRequest, string>()
const requestSpans = new WeakMap<FastifyRequest, TraceSpan>()
const requestErrors = new WeakMap<FastifyRequest, Error>()
const requestAbortControllers = new WeakMap<FastifyRequest, AbortController>()
const NEVER_ABORTED_SIGNAL = new AbortController().signal

/**
 * HTTP 边缘执行顺序与安全职责（Fastify 生命周期，自左向右；与本文件 hook、bindRoute 共同构成）：
 *
 * onRequest #1  创建 AbortController（断连/客户端取消 → 全链路取消）+ CORS 白名单 + OPTIONS 短路 204
 * onRequest #2  trace 提取/生成（x-trace-id、span 起）
 * body 解析      JSON parser 强制 bodyLimit（1MiB，超限 413）——大小限制先于一切业务
 * preHandler    [auth, 限流, ...]（bindRoute 组装，auth 恒在前，Fastify 遇错短路）
 *               → 已认证请求才消耗限流配额；认证晚于 body 解析是 Fastify 生命周期决定的，
 *                 不做 auth-before-body，缓解手段为 bodyLimit + preHandler 限流（见 backend/STACK.md）
 * handler       zod 校验(unknown→DTO) → Controller 业务 → sendOk 信封 / 文件字节流 / SSE 帧流
 * onError       setErrorHandler 统一错误信封 {code, message, data:null}（映射见 error-mapper.ts）
 * onResponse    span 收尾（http.route + http.status_code）
 *
 * fail-closed 点：认证配置缺失在启动期失败（bindRoute 断言）；错误信封不泄漏内部信息；
 * body 超限提前拒绝；CORS 仅放行配置白名单。
 */
export function createHttpServer(options: HttpServerOptions): FastifyInstance {
  const jsonBodyLimit = positiveInteger(options.jsonBodyLimit, DEFAULT_JSON_BODY_LIMIT)
  const tracer = options.tracer ?? new NoopTracer()
  const traceIdGenerator = options.traceIdGenerator ?? generateTraceId
  const allowedOrigins = parseOrigins(options.corsOrigins ?? '')
  const allowAllOrigins = allowedOrigins.length === 1 && allowedOrigins[0] === '*'
  const server = fastify({
    logger: options.logger ?? false,
    requestIdHeader: REQUEST_ID_HEADER,
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    genReqId: (): string => options.idGenerator.generate('REQ'),
  })

  configureContentTypes(server, jsonBodyLimit)
  void server.register(multipart)

  server.addHook('onRequest', async (request, reply): Promise<void> => {
    const controller = new AbortController()
    if (request.raw.aborted) controller.abort(new Error('HTTP request aborted'))
    else {
      request.raw.once('aborted', (): void => {
        controller.abort(new Error('HTTP request aborted'))
      })
    }
    reply.raw.once('close', (): void => {
      if (!reply.raw.writableFinished) {
        controller.abort(new Error('HTTP response disconnected'))
      }
    })
    requestAbortControllers.set(request, controller)
    reply.header(REQUEST_ID_HEADER, request.id)
    const origin = firstHeader(request.headers.origin)
    if (origin === undefined || allowedOrigins.length === 0) return

    if (allowAllOrigins) {
      reply.header('access-control-allow-origin', '*')
    } else if (allowedOrigins.includes(origin)) {
      reply.header('access-control-allow-origin', origin)
      reply.header('vary', 'Origin')
      reply.header('access-control-allow-credentials', 'true')
    }
    reply.header('access-control-allow-methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
    reply.header(
      'access-control-allow-headers',
      'Origin, Content-Type, Accept, Authorization, X-Request-ID'
    )
    reply.header('access-control-expose-headers', 'X-Request-ID, X-Trace-ID')
    if (request.method === 'OPTIONS') await reply.status(204).send()
  })

  server.addHook('onRequest', (request, reply, done): void => {
    if (reply.sent) {
      done()
      return
    }
    const extracted = options.traceContextExtractor?.extract(request.headers)
    const traceId =
      extracted?.traceId === '' || extracted === undefined ? traceIdGenerator() : extracted.traceId
    requestTraceIds.set(request, traceId)
    reply.header(TRACE_ID_HEADER, traceId)

    const attributes = [
      { key: 'request.id', value: request.id },
      { key: 'trace.id', value: traceId },
      { key: 'http.method', value: request.method },
      { key: 'http.path', value: request.url },
    ]
    if (extracted?.parentSpanId !== undefined && extracted.parentSpanId !== '') {
      attributes.push({ key: 'trace.parent_span_id', value: extracted.parentSpanId })
    }
    if (extracted?.traceFlags !== undefined) {
      attributes.push({ key: 'trace.flags', value: String(extracted.traceFlags) })
    }
    if (extracted?.traceState !== undefined && extracted.traceState !== '') {
      attributes.push({ key: 'trace.state', value: extracted.traceState })
    }
    const span = tracer.start({ name: 'http.request', attributes })
    requestSpans.set(request, span)
    void span
      .within((): Promise<void> => {
        done()
        return Promise.resolve()
      })
      .catch((error: unknown): void => {
        done(normalizeError(error))
      })
  })

  server.addHook('onError', (request, _reply, error, done): void => {
    requestErrors.set(request, error)
    done()
  })

  server.addHook('onResponse', (request, reply, done): void => {
    const span = requestSpans.get(request)
    if (span !== undefined) {
      span.setAttributes(
        { key: 'http.route', value: request.routeOptions.url ?? '' },
        { key: 'http.status_code', value: String(reply.statusCode) }
      )
      span.end(requestErrors.get(request))
      requestSpans.delete(request)
      requestErrors.delete(request)
      requestTraceIds.delete(request)
    }
    requestAbortControllers.delete(request)
    done()
  })

  server.setErrorHandler((error, request, reply): void => {
    const safeError = normalizeHttpError(error, jsonBodyLimit)
    if (safeError.cause !== undefined) {
      request.log.error(
        { err: normalizeError(safeError.cause), path: request.url },
        safeError.logMessage ?? 'unhandled error'
      )
    } else if (!(error instanceof AppError)) {
      request.log.error({ err: normalizeError(error), path: request.url }, 'unhandled error')
    } else {
      request.log.debug({ err: error, path: request.url }, 'request error')
    }
    const response = errorResponse(safeError)
    void reply.status(response.status).send(response.body)
  })

  server.setNotFoundHandler((): never => {
    throw notFoundError('资源不存在')
  })
  return server
}

export function requestTraceId(request: FastifyRequest): string {
  return requestTraceIds.get(request) ?? ''
}

export function requestAbortSignal(request: FastifyRequest): AbortSignal {
  return requestAbortControllers.get(request)?.signal ?? NEVER_ABORTED_SIGNAL
}

/** 单实例固定窗口限流器；需要全局配额时由网关或 Redis adapter 替代。 */
export class FixedWindowRateLimiter {
  readonly #entries = new Map<string, FixedWindowEntry>()
  readonly #limit: number
  readonly #windowMilliseconds: number
  readonly #now: () => number
  #lastCleanup: number

  public constructor(options: FixedWindowRateLimiterOptions) {
    this.#limit = positiveInteger(options.limit, 1)
    this.#windowMilliseconds = positiveInteger(
      options.windowMilliseconds,
      DEFAULT_RATE_LIMIT_WINDOW_MILLISECONDS
    )
    this.#now = options.now ?? Date.now
    this.#lastCleanup = this.#now()
  }

  public preHandler(): preHandlerAsyncHookHandler {
    return async (request, reply): Promise<void> => {
      const decision = this.allow(request.ip, this.#now())
      if (decision.allowed) return
      reply.header('retry-after', String(decision.retryAfterSeconds))
      throw rateLimitError('请求过于频繁，请稍后再试')
    }
  }

  private allow(key: string, now: number): RateLimitDecision {
    if (now - this.#lastCleanup >= this.#windowMilliseconds) {
      for (const [entryKey, entry] of this.#entries.entries()) {
        if (now - entry.windowStartedAt >= this.#windowMilliseconds) {
          this.#entries.delete(entryKey)
        }
      }
      this.#lastCleanup = now
    }

    const entry = this.#entries.get(key)
    if (entry === undefined || now - entry.windowStartedAt >= this.#windowMilliseconds) {
      this.#entries.set(key, { count: 1, windowStartedAt: now })
      return { allowed: true, retryAfterSeconds: 0 }
    }
    if (entry.count >= this.#limit) {
      const remaining = this.#windowMilliseconds - (now - entry.windowStartedAt)
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(remaining / 1_000)),
      }
    }
    entry.count += 1
    return { allowed: true, retryAfterSeconds: 0 }
  }
}

function configureContentTypes(server: FastifyInstance, bodyLimit: number): void {
  const parser = server.getDefaultJsonParser('error', 'error')
  server.removeContentTypeParser('application/json')
  server.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit }, parser)
  server.addContentTypeParser(
    /^application\/[^;\s]+\+json(?:\s*;.*)?$/i,
    { parseAs: 'string', bodyLimit },
    parser
  )
}

function normalizeHttpError(error: unknown, jsonBodyLimit: number): AppError {
  if (error instanceof AppError) return error
  if (hasErrorCode(error, 'FST_ERR_CTP_BODY_TOO_LARGE')) {
    return payloadTooLargeError(`JSON 请求体不能超过 ${jsonBodyLimit} 字节`)
  }
  return loggedInternalError('unhandled error', error)
}

function hasErrorCode(error: unknown, expected: string): boolean {
  return error instanceof Error && 'code' in error && error.code === expected
}

function parseOrigins(value: string): readonly string[] {
  return value
    .split(',')
    .map((origin): string => origin.trim())
    .filter((origin): boolean => origin !== '')
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : value?.[0]
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function generateTraceId(): string {
  return randomBytes(16).toString('hex')
}
