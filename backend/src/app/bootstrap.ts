import type { PasswordHasher } from '../modules/identity/public-api.js'
import type { AppConfig } from '../infra/config/config.js'
import { PostgresMigrator, type DatabaseMigrationGatePort } from '../infra/database/migrator.js'
import type { Logger } from '../infra/logger/logger.js'
import type { SqlExecutor, TransactionalSqlExecutor } from '../infra/database/postgres.js'

const DEFAULT_CREDENTIAL_ID = 'CRED_default_001'
const DEFAULT_LLM_CONFIG_ID = 'LLMC_default_001'
const DEFAULT_LLM_CONFIG_NAME = 'default'
const DEFAULT_AGENT_ID = 'default'
const DEFAULT_USER_ID = 'USER_default_001'
/**
 * 默认助手（`default`）默认启用的系统工具。
 *
 * 每次启动都会把这里的内容并入 `core_agents.sys_tool_ids`，因此「给默认 Agent 授权」必须改这里，
 * 只改数据库会在下次启动时被并集覆盖。
 *
 * `sys_shell` 是任意命令执行，把它列入这里是明确的安全边界决策，理由与代价见
 * `docs/decisions/2026-09-17-default-agent-shell-authorization.md`。该授权**不**延伸到定时任务：
 * `EXCLUDED_TASK_TOOL_NAMES` 排除 `sys_shell`，理由见
 * `docs/decisions/2026-10-08-scheduled-task-shell-exclusion.md`。
 */
const DEFAULT_AGENT_TOOL_IDS = Object.freeze([
  'sys_get_time',
  'sys_scheduled_task_manage',
  'sys_ask_user',
  'sys_shell',
])

export interface DatabaseBootstrapOptions {
  readonly config: AppConfig
  readonly database: TransactionalSqlExecutor
  readonly passwordHasher: PasswordHasher
  readonly logger: Logger
  readonly signal: AbortSignal
  readonly migrator?: DatabaseMigrationGatePort | undefined
}

/** 应用或校验冻结的数据库结构，并以幂等方式创建必需的默认记录。 */
export async function bootstrapDatabase(options: DatabaseBootstrapOptions): Promise<void> {
  const migrator = options.migrator ?? new PostgresMigrator(options.database)
  if (options.config.database.autoMigrate) {
    const group = await migrator.up(options.signal)
    options.logger.info(
      group.migrationNames.length === 0 ? 'database schema is current' : 'database migrated',
      { migration_count: group.migrationNames.length, migration_group: group.groupId }
    )
  } else {
    const status = await migrator.status(options.signal)
    const pending = status.filter((item): boolean => item.status === 'pending')
    if (pending.length > 0) {
      throw new Error(
        `存在未应用迁移 ${pending.map((item): string => item.name).join(', ')}，请先运行 migrate up`
      )
    }
    options.logger.info('database schema is current')
  }

  await seedDefaults(
    options.database,
    options.config,
    options.passwordHasher,
    options.logger,
    options.signal
  )
}

async function seedDefaults(
  database: SqlExecutor,
  config: AppConfig,
  passwordHasher: PasswordHasher,
  logger: Logger,
  signal: AbortSignal
): Promise<void> {
  await database.query(
    `INSERT INTO api_credentials
       (api_credential_id, name, provider, api_base_url, api_key)
     VALUES ($1, $2, 'openai', $3, $4)
     ON CONFLICT (api_credential_id) DO NOTHING`,
    [DEFAULT_CREDENTIAL_ID, 'Default OpenAI', config.llm.baseUrl, config.llm.apiKey],
    signal
  )
  await database.query(
    `INSERT INTO llm_configs
       (llm_config_id, name, description, provider, model_name, credential_id)
     VALUES ($1, $2, $3, 'openai', $4, $5)
     ON CONFLICT (llm_config_id) DO NOTHING`,
    [
      DEFAULT_LLM_CONFIG_ID,
      DEFAULT_LLM_CONFIG_NAME,
      '默认对话模型配置',
      config.llm.model,
      DEFAULT_CREDENTIAL_ID,
    ],
    signal
  )
  await database.query(
    `INSERT INTO core_agents
       (agent_id, name, agent_type, description, system_prompt,
        sys_tool_ids, service_tool_ids, available_agent_ids,
        llm_config_name, model_params, metadata, is_active)
     VALUES ($1, $2, 'executor', $3, $4,
             $5::text[], $6::text[], $7::text[],
             $8, $9::jsonb, $10::jsonb, TRUE)
     ON CONFLICT (agent_id) DO NOTHING`,
    [
      DEFAULT_AGENT_ID,
      '默认助手',
      '默认 AI 助手，理解用户需求并提供有用的回答',
      '你是一个智能助手，能够理解用户需求并提供有用的回答。创建定时任务时，task_input 必须完整自包含地保留用户的需求（完整 URL、具体步骤、期望产出），不要概括或省略——任务触发时只有 task_input 作为执行指令。',
      [],
      [],
      [],
      DEFAULT_LLM_CONFIG_NAME,
      JSON.stringify({ temperature: 0.7, max_tokens: 2_000 }),
      JSON.stringify({ max_tool_iterations: 30 }),
    ],
    signal
  )
  await database.query(
    `UPDATE core_agents
     SET sys_tool_ids = ARRAY(
       SELECT DISTINCT unnest(
         array_remove(
           array_remove(
             array_remove(sys_tool_ids, 'sys_fetch_url'),
             'sys_http_request'
           ),
           'sys_read_file'
         ) || $1::text[]
       )
     )
     WHERE agent_id = $2`,
    [DEFAULT_AGENT_TOOL_IDS, DEFAULT_AGENT_ID],
    signal
  )
  await seedDefaultUser(database, config, passwordHasher, signal)
  logger.info('database defaults initialized')
}

async function seedDefaultUser(
  database: SqlExecutor,
  config: AppConfig,
  passwordHasher: PasswordHasher,
  signal: AbortSignal
): Promise<void> {
  if (config.devUser.username === '' || config.devUser.password === '') return
  const existing = await database.query(
    'SELECT 1 FROM users WHERE id = $1 LIMIT 1',
    [DEFAULT_USER_ID],
    signal
  )
  if (existing.rows.length > 0) return
  const passwordHash = await passwordHasher.hash(config.devUser.password)
  await database.query(
    `INSERT INTO users (id, username, email, password_hash, display_name, is_active)
     VALUES ($1, $2, $3, $4, $5, TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [
      DEFAULT_USER_ID,
      config.devUser.username,
      config.devUser.email,
      passwordHash,
      config.devUser.displayName || config.devUser.username,
    ],
    signal
  )
}
