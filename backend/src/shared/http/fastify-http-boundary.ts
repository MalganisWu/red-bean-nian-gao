import { randomBytes } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'

import multipart from '@fastify/multipart'
import fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyServerOptions,
  type HookHandlerDoneFunction,
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

/** 从入站 header 抽出的 trace 上下文；字段名与 W3C traceparent 对齐。 */
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

/** 建 server 的选项；除 `idGenerator` 外全可注入，测试因此能替换 tracer、trace 提取器与 CORS 白名单。 */
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

/** 限流参数；`now` 可注入，测试因此不必真的等满一个窗口。 */
export interface FixedWindowRateLimiterOptions {
  readonly limit: number
  readonly windowMilliseconds: number
  readonly now?: (() => number) | undefined
}

interface RateLimitDecision {
  readonly allowed: boolean
  readonly retryAfterSeconds: number
}

/** trace 钩子依赖；由 `createHttpServer` 从选项解析后一次性预构建，避免在注册处现场组装。 */
interface TraceHookDependencies {
  readonly extractor: TraceContextExtractorPort | undefined
  readonly generateTraceId: () => string
  readonly tracer: TracerPort
}

/*
 * 请求级状态挂在 WeakMap 上，而不是塞进 request 对象或某个全局 Map。
 * WeakMap 的键是请求对象本身：请求结束、没有别的引用之后条目自动消失，
 * 既不需要在 onResponse 里逐个清理（下面那些 delete 只是为了及时释放大对象），
 * 也不会让并发请求之间串状态。
 */
const requestTraceIds = new WeakMap<FastifyRequest, string>()
const requestSpans = new WeakMap<FastifyRequest, TraceSpan>()
const requestErrors = new WeakMap<FastifyRequest, Error>()
const requestAbortControllers = new WeakMap<FastifyRequest, AbortController>()
/** 没有 AbortController 时的兜底信号：永不会中止，避免调用方到处判空。 */
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
 * @param options - 建 server 的选项；除 `idGenerator` 外均可注入，便于测试替换 tracer、trace 提取器与 CORS 白名单。
 * @returns 已挂好钩子与错误处理的 Fastify 实例，尚未开始监听。
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

  server.addHook('onRequest', (request, reply): Promise<void> =>
    beginRequestContext(request, reply, allowedOrigins, allowAllOrigins)
  )

  // trace 钩子的依赖先具名预构建，注册处只做单行转发。
  const traceDependencies: TraceHookDependencies = {
    extractor: options.traceContextExtractor,
    generateTraceId: traceIdGenerator,
    tracer,
  }
  server.addHook('onRequest', (request, reply, done): void =>
    attachTraceContext(request, reply, done, traceDependencies)
  )

  server.addHook('onError', (request, _reply, error, done): void =>
    recordRequestError(request, error, done)
  )

  server.addHook('onResponse', (request, reply, done): void =>
    finishRequestSpan(request, reply, done)
  )

  /**
   * 统一错误出口。**日志级别按「这是不是我们预期的错误」分层**：
   * 有 `cause` 或非 `AppError` 的走 error（同一条错误反复出现说明有故障），
   * 而 `AppError` 是业务主动抛的（404、限流、校验失败），走 debug——
   * 把用户输错参数记成 error 会让真正的故障淹没在噪声里。
   */
  server.setErrorHandler((error, request, reply): void =>
    handleRequestError(error, request, reply, jsonBodyLimit)
  )

  server.setNotFoundHandler((): never => {
    throw notFoundError('资源不存在')
  })
  return server
}

/**
 * onRequest 钩子 #1：建立请求级取消信号（断连 → 全链路取消）、写入 request id，
 * 并按 CORS 白名单放行或短路 OPTIONS。
 */
async function beginRequestContext(
  request: FastifyRequest,
  reply: FastifyReply,
  allowedOrigins: readonly string[],
  allowAllOrigins: boolean
): Promise<void> {
  /*
   * 两种断连必须都覆盖，只监听一个会漏掉一半的取消来源：
   * - `aborted`：请求还没读完客户端就断了。
   * - `close` + `writableFinished === false`：响应还没写完连接就关了（SSE 场景里这是最常见的）。
   *   加 `writableFinished` 判断是因为正常结束也会触发 `close`，不加就会把每次正常请求都当成取消。
   */
  const controller = new AbortController()
  if (request.raw.aborted) controller.abort(new Error('HTTP request aborted'))
  else {
    request.raw.once('aborted', (): void => {
      controller.abort(new Error('HTTP request aborted'))
    })
  }
  /** 连接关闭且响应未写完：视为客户端断连，中止整条链路。 */
  function onResponseClose(): void {
    if (!reply.raw.writableFinished) {
      controller.abort(new Error('HTTP response disconnected'))
    }
  }
  reply.raw.once('close', onResponseClose)
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
}

/** onRequest 钩子 #2：提取或生成 trace ID，起 `http.request` span，并在其异步上下文里放行后续处理。 */
function attachTraceContext(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction,
  dependencies: TraceHookDependencies
): void {
  if (reply.sent) {
    done()
    return
  }
  const extracted = dependencies.extractor?.extract(request.headers)
  const traceId =
    extracted?.traceId === '' || extracted === undefined
      ? dependencies.generateTraceId()
      : extracted.traceId
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
  const span = dependencies.tracer.start({ name: 'http.request', attributes })
  requestSpans.set(request, span)
  /*
   * 用 `span.within` 包住 `done()` 而不是直接调用：`within` 会把该 span 设为异步上下文里的活跃 span，
   * 后续 handler 里新建的 span（LLM、工具、DB）才能自动挂到它下面。
   * 这也解释了为什么必须用 `void ... .catch`：`within` 返回 Promise，而 Fastify 的 done 回调风格
   * 要求同步返回，只能把异步失败转回 `done(error)`。
   */
  /** 在 span 的异步上下文里放行 `done`，使后续新建的 span 自动挂到它下面。 */
  function continueWithinSpan(): Promise<void> {
    done()
    return Promise.resolve()
  }
  void span.within(continueWithinSpan).catch((error: unknown): void => {
    done(normalizeError(error))
  })
}

/** onError 钩子：暂存本次请求的错误，供 onResponse 收尾 span 时取用。 */
function recordRequestError(
  request: FastifyRequest,
  error: Error,
  done: HookHandlerDoneFunction
): void {
  requestErrors.set(request, error)
  done()
}

/** onResponse 钩子：收尾 `http.request` span（补 route 与状态码）并释放请求级引用。 */
function finishRequestSpan(
  request: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
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
}

/** setErrorHandler 处理器：把任意错误归一化为错误信封，并按「是否预期」分层记录日志。 */
function handleRequestError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
  jsonBodyLimit: number
): void {
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
}

/**
 * 取本次请求的 trace ID；请求没走到 trace hook 时返回空串。
 * @param request - 当前 Fastify 请求。
 * @returns 本次请求的 trace ID；未走到 trace hook 时为空串。
 */
export function requestTraceId(request: FastifyRequest): string {
  return requestTraceIds.get(request) ?? ''
}

/**
 * 取本次请求的取消信号；无控制器时返回永不中止的兜底信号，调用方因此不必判空。
 * @param request - 当前 Fastify 请求。
 * @returns 本次请求的取消信号；无控制器时为永不中止的兜底信号。
 */
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

  /**
   * 生成限流 preHandler 钩子：按客户端 IP 判定配额，超限时写 `retry-after` 并抛 429。
   * @returns 绑定到本实例配额的 Fastify 异步 preHandler 钩子。
   */
  public preHandler(): preHandlerAsyncHookHandler {
    /** 按客户端 IP 判定配额；超限时写 `retry-after` 并抛 429。 */
    const rateLimitGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const decision = this.allow(request.ip, this.#now())
      if (decision.allowed) return
      reply.header('retry-after', String(decision.retryAfterSeconds))
      throw rateLimitError('请求过于频繁，请稍后再试')
    }
    return rateLimitGuard
  }

  private allow(key: string, now: number): RateLimitDecision {
    /*
     * 惰性清理而不是定时器：只在「距上次清理超过一个窗口」时才扫一遍，
     * 把 O(条目数) 的成本摊到多次请求上。定时器会在服务空闲时也持续唤醒事件循环，
     * 而且需要在关闭时显式清掉，这里没必要引入那份复杂度。
     */
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
