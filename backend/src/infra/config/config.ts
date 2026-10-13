/** `server` 段：监听地址、环境名与日志格式/级别。 */
export interface ServerConfig {
  readonly host: string
  readonly port: string
  readonly env: string
  readonly logFormat: string
  readonly logLevel: string
}

/** `database` 段：连接串与是否在启动时自动迁移（生产必须关闭）。 */
export interface DatabaseConfig {
  readonly url: string
  readonly autoMigrate: boolean
}

/** `redis` 段：连接串。会话锁、取消注册表与投递队列共用这一个连接。 */
export interface RedisConfig {
  readonly url: string
}

/** `jwt` 段：签发密钥。生产环境要求至少 32 字节。 */
export interface JwtConfig {
  readonly secret: string
}

/** `minio` 段：对象存储的端点、凭据与默认桶。 */
export interface MinioConfig {
  readonly endpoint: string
  readonly accessKey: string
  readonly secretKey: string
  readonly bucket: string
  readonly useSsl: boolean
  readonly region: string
}

/** `cors` 段：允许的来源，逗号分隔；单值 `*` 表示全部放行（仅限本地）。 */
export interface CorsConfig {
  readonly origins: string
}

/** `llm` 段：默认 provider 凭据与模型名；仅用于播种默认记录，不是 Agent 实际使用的配置。 */
export interface LlmConfig {
  readonly apiKey: string
  readonly baseUrl: string
  readonly model: string
}

/** `dev_user` 段：本地开发账号；用户名或密码为空则不创建。 */
export interface DevUserConfig {
  readonly username: string
  readonly password: string
  readonly displayName: string
  readonly email: string
}

/** `scheduled_task` 段：调度器的扫描节奏、并发上限、重试策略与超时预算。 */
export interface ScheduledTaskConfig {
  readonly maxRetries: number
  readonly retryInterval: string
  readonly timezone: string
  readonly scanInterval: string
  readonly batchSize: number
  readonly maxConcurrent: number
  readonly executionTimeout: string
}

/** `observability` 段：tracing 后端（structured / otlp）、服务名与采样率。 */
export interface ObservabilityConfig {
  readonly exporter: string
  readonly serviceName: string
  readonly sampleRatio: number
}

/** 应用配置全集；由 `config.yaml` 与环境变量合并而成，`loadConfig` 之后不再变化。 */
export interface AppConfig {
  readonly server: ServerConfig
  readonly database: DatabaseConfig
  readonly redis: RedisConfig
  readonly jwt: JwtConfig
  readonly minio: MinioConfig
  readonly cors: CorsConfig
  readonly llm: LlmConfig
  readonly devUser: DevUserConfig
  readonly scheduledTask: ScheduledTaskConfig
  readonly observability: ObservabilityConfig
}

type Environment = Readonly<Record<string, string | undefined>>
type UnknownRecord = Record<string, unknown>

/** 加载选项；两个字段都可注入，测试因此无需依赖真实文件系统与环境变量。 */
export interface LoadConfigOptions {
  readonly directory?: string
  readonly environment?: Environment
}

const DURATION_PART = /(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|s|m|h)/gu
const DURATION_UNITS: Readonly<Record<string, number>> = Object.freeze({
  ns: 0.000_001,
  us: 0.001,
  µs: 0.001,
  μs: 0.001,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
})

/**
 * 读取并合并配置，是 `AppConfig` 的唯一装配入口。
 * 只做两件事：读 `config.yaml`、把结果交给 `parseConfig` 合并环境变量。
 * 校验责任不在本层——非法配置（缺必填、残留 `CHANGE_ME`、生产环境弱密钥）由
 * `parseConfig` 内部的 `validateConfig` 抛错拦截，因此**本函数要么返回一份已通过
 * 全部校验的配置，要么直接抛错**，调用方不必再自行校验，也不应吞掉这里的异常继续启动。
 * @param options - 注入点；`directory` 覆盖配置文件所在目录，`environment` 覆盖环境变量来源
 * @returns 已完成校验、此后不再变化的配置全集
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<AppConfig> {
  const directory = options.directory ?? process.cwd()
  const environment = options.environment ?? process.env
  const base = await readYamlConfig(join(directory, 'config.yaml'))
  /*
   * 本地单源：不再有 `config.local.yaml` 覆盖层。所有本地覆盖都走环境变量
   * （`backend/.env.local` 在进程入口注入 `process.env`，见 `load-local-env-file.ts`）。
   * 链路由三段收敛为两段：config.yaml（入库默认值） → process.env。
   */
  return parseConfig(record(base), environment)
}

/**
 * 合并两个来源并按优先级取值：**环境变量 > config.yaml > 内置默认值**。
 *
 * 每个字段都显式写出四个参数（YAML 段、YAML 键、环境变量名、默认值），
 * 看起来啰嗦，但它让「这个配置项叫什么、能被哪个环境变量覆盖」成为类型层面可见的事实——
 * 隐式的命名约定会让部署时该设哪个变量变成要靠猜的事。
 *
 * 空字符串一律视为「未设置」而不是有效取值：环境文件里留空的项应当落到下一个来源，
 * 而不是把一个空串当成配置。真正的必填校验在后面的 `validate*` 里做。
 *
 * 校验责任集中在本函数：它在返回前调用 `validateConfig`，**非法配置一律抛错**，
 * 不做「降级到默认值」的兜底。因此本函数的失败语义是「启动即失败」，
 * 调用方拿到返回值就意味着所有必填项与生产环境加严项都已验过。
 * @param raw - `config.yaml` 解析出的原始值；不是对象时直接抛错，不做隐式转换
 * @param environment - 环境变量来源；同名变量优先于 YAML 值，空串视为未设置
 * @returns 合并后的配置全集；已在返回前完成全部校验
 */
export function parseConfig(raw: unknown, environment: Environment): AppConfig {
  const root = record(raw)
  const server = section(root, 'server')
  const database = section(root, 'database')
  const redis = section(root, 'redis')
  const jwt = section(root, 'jwt')
  const minio = section(root, 'minio')
  const cors = section(root, 'cors')
  const llm = section(root, 'llm')
  const devUser = section(root, 'dev_user')
  const scheduledTask = section(root, 'scheduled_task')
  const observability = section(root, 'observability')

  const config: AppConfig = {
    server: {
      host: stringValue(server, 'host', environment, 'SERVER_HOST', '0.0.0.0'),
      port: stringValue(server, 'port', environment, 'SERVER_PORT', '8080'),
      env: stringValue(server, 'env', environment, 'SERVER_ENV', 'local'),
      logFormat: stringValue(server, 'log_format', environment, 'SERVER_LOG_FORMAT', 'text'),
      logLevel: stringValue(server, 'log_level', environment, 'SERVER_LOG_LEVEL', 'info'),
    },
    database: {
      url: stringValue(database, 'url', environment, 'DATABASE_URL', ''),
      autoMigrate: booleanValue(
        database,
        'auto_migrate',
        environment,
        'DATABASE_AUTO_MIGRATE',
        false
      ),
    },
    redis: { url: stringValue(redis, 'url', environment, 'REDIS_URL', '') },
    jwt: { secret: stringValue(jwt, 'secret', environment, 'JWT_SECRET', '') },
    minio: {
      endpoint: stringValue(minio, 'endpoint', environment, 'MINIO_ENDPOINT', ''),
      accessKey: stringValue(minio, 'access_key', environment, 'MINIO_ACCESS_KEY', ''),
      secretKey: stringValue(minio, 'secret_key', environment, 'MINIO_SECRET_KEY', ''),
      bucket: stringValue(minio, 'bucket', environment, 'MINIO_BUCKET', 'red-bean-nian-gao'),
      useSsl: booleanValue(minio, 'use_ssl', environment, 'MINIO_USE_SSL', false),
      region: stringValue(minio, 'region', environment, 'MINIO_REGION', ''),
    },
    cors: {
      origins: stringValue(cors, 'origins', environment, 'CORS_ORIGINS', ''),
    },
    llm: {
      apiKey: stringValue(llm, 'api_key', environment, 'LLM_API_KEY', ''),
      baseUrl: stringValue(llm, 'base_url', environment, 'LLM_BASE_URL', ''),
      model: stringValue(llm, 'model', environment, 'LLM_MODEL', 'gpt-4'),
    },
    devUser: {
      username: stringValue(devUser, 'username', environment, 'DEV_USER_USERNAME', ''),
      password: stringValue(devUser, 'password', environment, 'DEV_USER_PASSWORD', ''),
      displayName: stringValue(devUser, 'display_name', environment, 'DEV_USER_DISPLAY_NAME', ''),
      email: stringValue(devUser, 'email', environment, 'DEV_USER_EMAIL', ''),
    },
    scheduledTask: {
      maxRetries: numberValue(
        scheduledTask,
        'max_retries',
        environment,
        'SCHEDULED_TASK_MAX_RETRIES',
        3
      ),
      retryInterval: stringValue(
        scheduledTask,
        'retry_interval',
        environment,
        'SCHEDULED_TASK_RETRY_INTERVAL',
        '5m'
      ),
      timezone: stringValue(
        scheduledTask,
        'timezone',
        environment,
        'SCHEDULED_TASK_TIMEZONE',
        'Asia/Shanghai'
      ),
      scanInterval: stringValue(
        scheduledTask,
        'scan_interval',
        environment,
        'SCHEDULED_TASK_SCAN_INTERVAL',
        '1m'
      ),
      batchSize: numberValue(
        scheduledTask,
        'batch_size',
        environment,
        'SCHEDULED_TASK_BATCH_SIZE',
        100
      ),
      maxConcurrent: numberValue(
        scheduledTask,
        'max_concurrent',
        environment,
        'SCHEDULED_TASK_MAX_CONCURRENT',
        4
      ),
      executionTimeout: stringValue(
        scheduledTask,
        'execution_timeout',
        environment,
        'SCHEDULED_TASK_EXECUTION_TIMEOUT',
        '15m'
      ),
    },
    observability: {
      exporter: stringValue(
        observability,
        'exporter',
        environment,
        'OBSERVABILITY_EXPORTER',
        'structured'
      ),
      serviceName: stringValue(
        observability,
        'service_name',
        environment,
        'OTEL_SERVICE_NAME',
        'red-bean-nian-gao'
      ),
      sampleRatio: numberValue(
        observability,
        'sample_ratio',
        environment,
        'OTEL_TRACES_SAMPLER_ARG',
        1
      ),
    },
  }

  validateConfig(config)
  return config
}

/**
 * 解析 duration 字面量（`5m`、`1h30m`、`250ms`）为毫秒。
 *
 * `match.index !== position` 这个判断是这里的要点：它要求各段**首尾相接、没有空隙**，
 * 因此 `1h junk 30m` 会被拒绝而不是被静默解析成 `1h30m`。
 * 正则的 `matchAll` 本身会跳过不匹配的片段，不检查位置就等于放任拼写错误。
 *
 * 末尾拒绝 `<= 0`：这些值最终都用作间隔或超时，0 与负数在这里没有合理语义，
 * 与其让它们在下游变成「永不触发」或「立刻超时」，不如在配置层挡住。
 * @param value - duration 字面量，如 `5m` / `250ms`；可以是字符串以外的原始类型，但只有合法字符串才有结果
 * @returns 解析出的毫秒数；不可能为 0 或负数——非法输入一律抛错
 */
export function parseDurationMilliseconds(value: string): number {
  const normalized = value.trim()
  const sign = normalized.startsWith('-') ? -1 : 1
  const unsigned =
    normalized.startsWith('-') || normalized.startsWith('+') ? normalized.slice(1) : normalized
  if (unsigned.length === 0) throw new Error('duration is invalid')

  let position = 0
  let milliseconds = 0
  for (const match of unsigned.matchAll(DURATION_PART)) {
    const wholeMatch = match[0]
    const amountText = match[1]
    const unit = match[2]
    if (match.index !== position || amountText === undefined || unit === undefined) {
      throw new Error('duration is invalid')
    }
    const multiplier = DURATION_UNITS[unit]
    if (multiplier === undefined) throw new Error('duration is invalid')
    milliseconds += Number(amountText) * multiplier
    position += wholeMatch.length
  }
  if (position !== unsigned.length || !Number.isFinite(milliseconds)) {
    throw new Error('duration is invalid')
  }
  milliseconds *= sign
  if (milliseconds <= 0) throw new Error('duration must be greater than zero')
  return milliseconds
}

/**
 * 启动即校验，分三档：
 * 1. **必填**：缺了就起不来（数据库/Redis/JWT/MinIO 的连接参数）。
 * 2. **示例值拦截**：模板里的 `CHANGE_ME` 没被替换掉，等价于没配置。
 * 3. **仅生产环境的加严**：`auto_migrate` 必须关（多副本并发 DDL 会互相踩），
 *    `jwt.secret` 至少 32 字节（弱密钥可被离线爆破）。本地开发不受这两条限制。
 *
 * 这个分层刻意如此——测试与本地要的是「能起来」，生产要的是「起不来也别起错」。
 */
function validateConfig(config: AppConfig): void {
  requireConfigured('database.url', config.database.url)
  requireConfigured('redis.url', config.redis.url)
  requireConfigured('jwt.secret', config.jwt.secret)
  requireConfigured('minio.endpoint', config.minio.endpoint)
  requireConfigured('minio.access_key', config.minio.accessKey)
  requireConfigured('minio.secret_key', config.minio.secretKey)

  if (isProduction(config.server.env) && config.database.autoMigrate) {
    throw new Error('生产环境 database.auto_migrate 必须关闭，请使用独立 migrate job')
  }
  if (isProduction(config.server.env) && config.jwt.secret.length < 32) {
    throw new Error('生产环境 jwt.secret 长度必须至少为 32 字节')
  }

  positiveInteger('scheduled_task.max_retries', config.scheduledTask.maxRetries)
  positiveInteger('scheduled_task.batch_size', config.scheduledTask.batchSize)
  positiveInteger('scheduled_task.max_concurrent', config.scheduledTask.maxConcurrent)
  validateDuration('scheduled_task.retry_interval', config.scheduledTask.retryInterval)
  validateDuration('scheduled_task.scan_interval', config.scheduledTask.scanInterval)
  validateDuration('scheduled_task.execution_timeout', config.scheduledTask.executionTimeout)
  validateTimezone(config.scheduledTask.timezone)

  const exporter = config.observability.exporter.trim().toLowerCase()
  if (exporter !== 'structured' && exporter !== 'otlp') {
    throw new Error('observability.exporter 必须是 structured 或 otlp')
  }
  if (config.observability.serviceName.trim().length === 0) {
    throw new Error('observability.service_name 未设置')
  }
  if (config.observability.sampleRatio <= 0 || config.observability.sampleRatio > 1) {
    throw new Error('observability.sample_ratio 必须在 (0, 1] 范围内')
  }
}

function requireConfigured(name: string, value: string): void {
  if (value.trim().length === 0) throw new Error(`${name} 未设置`)
  if (containsPlaceholder(value)) throw new Error(`${name} 仍为示例值`)
}

/**
 * 识别模板占位符。这条防线针对的失败模式很具体：`config.yaml` 里写着 `CHANGE_ME`，
 * 部署时忘了替换，服务照常启动、连接失败时报出一个毫无线索的错误。
 * 在这里拦住，错误信息就直接指向「你还是示例值」。
 */
function containsPlaceholder(value: string): boolean {
  const normalized = value.trim().toUpperCase()
  return normalized.includes('CHANGE_ME') || normalized === 'CHANGE-ME-TO-A-LONG-RANDOM-STRING'
}

function isProduction(environment: string): boolean {
  const normalized = environment.trim().toLowerCase()
  return normalized === 'prod' || normalized === 'production'
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} 必须是大于 0 的整数`)
  }
}

function validateDuration(name: string, value: string): void {
  try {
    parseDurationMilliseconds(value)
  } catch {
    throw new Error(`${name} 必须是大于 0 的 duration`)
  }
}

/**
 * 用 `Intl` 试构造一次来校验时区名，而不是维护一张时区清单——
 * 后者会随 tzdata 更新而过期，前者永远与运行时的实际能力一致。
 */
function validateTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format()
  } catch {
    throw new Error('scheduled_task.timezone 无效')
  }
}

function record(value: unknown): UnknownRecord {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value))
  }
  throw new Error('configuration root must be an object')
}

async function readYamlConfig(path: string): Promise<unknown> {
  let source: string
  try {
    source = await readFile(path, 'utf8')
  } catch (error: unknown) {
    throw new Error(`读取 ${configFileName(path)} 失败: ${errorMessage(error)}`, { cause: error })
  }

  try {
    const parsed: unknown = parseYaml(source)
    return parsed ?? {}
  } catch (error: unknown) {
    throw new Error(`解析 ${configFileName(path)} 失败: ${errorMessage(error)}`, { cause: error })
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function configFileName(path: string): string {
  const parts = path.split(/[\\/]/u)
  return parts.at(-1) ?? path
}

function section(root: UnknownRecord, name: string): UnknownRecord {
  const value = root[name]
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return Object.fromEntries(Object.entries(value))
}

function sourceValue(
  source: UnknownRecord,
  key: string,
  environment: Environment,
  environmentName: string
): unknown {
  const environmentValue = environment[environmentName]
  return environmentValue === undefined ? source[key] : environmentValue
}

function stringValue(
  source: UnknownRecord,
  key: string,
  environment: Environment,
  environmentName: string,
  fallback: string
): string {
  const value = sourceValue(source, key, environment, environmentName)
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new Error(`${environmentName} must be a string`)
}

function numberValue(
  source: UnknownRecord,
  key: string,
  environment: Environment,
  environmentName: string,
  fallback: number
): number {
  const value = sourceValue(source, key, environment, environmentName)
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${environmentName} must be a number`)
  return parsed
}

function booleanValue(
  source: UnknownRecord,
  key: string,
  environment: Environment,
  environmentName: string,
  fallback: boolean
): boolean {
  const value = sourceValue(source, key, environment, environmentName)
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  throw new Error(`${environmentName} must be a boolean`)
}
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { parse as parseYaml } from 'yaml'
