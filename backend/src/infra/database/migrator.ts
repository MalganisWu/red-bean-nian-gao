import { z } from 'zod'
import { normalizeError } from '../../shared/errors/normalize-error.js'

import type { SqlExecutor, TransactionalSqlExecutor } from './postgres.js'

const HISTORY_TABLE = 'schema_migrations'
const ADVISORY_LOCK_NAME = 'red-bean-nian-gao:schema_migrations'

export interface Migration {
  readonly name: string
  readonly comment: string
  readonly up: readonly string[]
  readonly down: readonly string[]
}

export interface MigrationGroup {
  readonly groupId: number
  readonly migrationNames: readonly string[]
}

export interface MigrationStatus {
  readonly name: string
  readonly comment: string
  readonly status: 'pending' | 'applied'
  readonly groupId?: number | undefined
  readonly migratedAt?: Date | undefined
}

/** 应用启动所需的数据库迁移端口；默认实现为 `PostgresMigrator`。 */
export interface DatabaseMigrationGatePort {
  up(signal: AbortSignal): Promise<MigrationGroup>
  status(signal: AbortSignal): Promise<readonly MigrationStatus[]>
}

/** migrate CLI 所需的完整迁移端口；默认实现为 `PostgresMigrator`。 */
export interface MigrationRunnerPort extends DatabaseMigrationGatePort {
  down(signal: AbortSignal): Promise<MigrationGroup>
}

interface AppliedMigration {
  readonly id: number
  readonly name: string
  readonly groupId: number
  readonly migratedAt: Date
}

const safeIntegerSchema = z
  .union([z.number().int(), z.string().regex(/^\d+$/u).transform(Number)])
  .refine(Number.isSafeInteger, 'must be a safe integer')

const historyRowSchema = z.object({
  id: safeIntegerSchema,
  name: z.string().regex(/^\d{14}$/u),
  group_id: safeIntegerSchema,
  migrated_at: z.date(),
})

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  migration(
    '20260604000001',
    'initial_schema',
    [
      `CREATE TABLE IF NOT EXISTS api_credentials (
        api_credential_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        provider VARCHAR(50) NOT NULL,
        api_base_url VARCHAR(512) NOT NULL DEFAULT '',
        api_key TEXT NOT NULL,
        description VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS llm_configs (
        llm_config_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description VARCHAR(500) NOT NULL DEFAULT '',
        provider VARCHAR(50) NOT NULL DEFAULT 'openai',
        model_name VARCHAR(100) NOT NULL DEFAULT '',
        credential_id VARCHAR(50),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS system_tools (
        tool_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        description TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      `CREATE TABLE IF NOT EXISTS mcp_servers (
        server_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        endpoint VARCHAR(512) NOT NULL,
        transport_type VARCHAR(20) NOT NULL DEFAULT 'streamable_http',
        auth_type VARCHAR(20) NOT NULL DEFAULT 'none',
        auth_config JSONB NOT NULL DEFAULT '{}',
        health_check_enabled BOOLEAN NOT NULL DEFAULT true,
        health_check_interval INT NOT NULL DEFAULT 60,
        last_health_status VARCHAR(20) DEFAULT 'unknown',
        last_health_checked_at TIMESTAMPTZ,
        consecutive_failures INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_mcp_transport CHECK (transport_type IN ('streamable_http', 'sse')),
        CONSTRAINT ck_mcp_auth_type CHECK (auth_type IN ('none', 'api_key', 'bearer_token'))
      )`,
      `CREATE TABLE IF NOT EXISTS service_tools (
        tool_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tool_type VARCHAR(20) NOT NULL DEFAULT 'mcp',
        mcp_server_id VARCHAR(50),
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_service_tool_type CHECK (tool_type IN ('mcp'))
      )`,
      `CREATE TABLE IF NOT EXISTS core_agents (
        agent_id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(200) NOT NULL,
        agent_type VARCHAR(20) NOT NULL DEFAULT 'executor',
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        sys_tool_ids TEXT[] NOT NULL DEFAULT '{}',
        service_tool_ids TEXT[] NOT NULL DEFAULT '{}',
        available_agent_ids TEXT[] NOT NULL DEFAULT '{}',
        llm_config_name VARCHAR(50) NOT NULL DEFAULT 'main',
        model_params JSONB NOT NULL DEFAULT '{}',
        metadata JSONB NOT NULL DEFAULT '{}',
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_core_agent_type CHECK (agent_type IN ('orchestrator', 'executor', 'specialist'))
      )`,
      `CREATE INDEX IF NOT EXISTS idx_core_agent_type ON core_agents (agent_type)`,
      `CREATE TABLE IF NOT EXISTS sessions (
        session_id VARCHAR(50) PRIMARY KEY,
        user_id VARCHAR(50) NOT NULL DEFAULT '',
        llm_context JSONB NOT NULL DEFAULT '[]',
        display_messages JSONB NOT NULL DEFAULT '[]',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
    ],
    [
      'DROP TABLE IF EXISTS sessions CASCADE',
      'DROP TABLE IF EXISTS core_agents CASCADE',
      'DROP TABLE IF EXISTS service_tools CASCADE',
      'DROP TABLE IF EXISTS mcp_servers CASCADE',
      'DROP TABLE IF EXISTS system_tools CASCADE',
      'DROP TABLE IF EXISTS llm_configs CASCADE',
      'DROP TABLE IF EXISTS api_credentials CASCADE',
    ]
  ),
  migration(
    '20260605000001',
    'sub_agent_executions',
    [
      `CREATE TABLE IF NOT EXISTS sub_agent_executions (
        execution_id VARCHAR(50) PRIMARY KEY,
        session_id VARCHAR(50) NOT NULL,
        request_id VARCHAR(50) NOT NULL DEFAULT '',
        agent_id VARCHAR(50) NOT NULL,
        agent_name VARCHAR(200) NOT NULL DEFAULT '',
        user_id VARCHAR(50) NOT NULL DEFAULT '',
        user_message TEXT NOT NULL DEFAULT '',
        system_prompt TEXT,
        display_messages JSONB NOT NULL DEFAULT '[]',
        llm_context JSONB NOT NULL DEFAULT '[]',
        model_name VARCHAR(100),
        tokens_used INT NOT NULL DEFAULT 0,
        elapsed_ms INT NOT NULL DEFAULT 0,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        result_summary TEXT,
        error_msg TEXT,
        parent_call_id VARCHAR(128),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        completed_at TIMESTAMPTZ,
        CONSTRAINT ck_sub_exec_status CHECK (status IN ('pending','running','completed','failed','interrupted','awaiting_user'))
      )`,
    ],
    ['DROP TABLE IF EXISTS sub_agent_executions CASCADE']
  ),
  migration(
    '20260607000001',
    'agent_task_executions',
    [
      `CREATE TABLE IF NOT EXISTS agent_task_executions (
        execution_id VARCHAR(50) PRIMARY KEY,
        task_id VARCHAR(50) NOT NULL,
        session_id VARCHAR(50) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        scheduled_at TIMESTAMPTZ NOT NULL,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        display_messages JSONB NOT NULL DEFAULT '[]',
        llm_context JSONB NOT NULL DEFAULT '[]',
        result_type VARCHAR(20),
        result_message TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_task_executions_task_id ON agent_task_executions (task_id)',
      'CREATE INDEX IF NOT EXISTS idx_task_executions_session_id ON agent_task_executions (session_id)',
      'CREATE INDEX IF NOT EXISTS idx_task_executions_status ON agent_task_executions (status)',
      'CREATE INDEX IF NOT EXISTS idx_task_executions_created_at ON agent_task_executions (created_at DESC)',
    ],
    ['DROP TABLE IF EXISTS agent_task_executions']
  ),
  migration(
    '20260608000001',
    'create_users',
    [
      `CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(64) PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(100) NOT NULL,
        avatar TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)',
      'CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)',
      'CREATE INDEX IF NOT EXISTS idx_users_is_active ON users(is_active)',
    ],
    ['DROP TABLE IF EXISTS users CASCADE']
  ),
  migration(
    '20260609000001',
    'create_scheduled_tasks',
    [
      `CREATE TABLE IF NOT EXISTS scheduled_tasks (
        scheduled_task_id VARCHAR(64) PRIMARY KEY,
        session_id VARCHAR(64) NOT NULL,
        task_input TEXT NOT NULL,
        schedule_type VARCHAR(20) NOT NULL DEFAULT 'once',
        run_at TIMESTAMPTZ,
        cron_expr VARCHAR(100),
        next_run_at TIMESTAMPTZ,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        retry_count INTEGER NOT NULL DEFAULT 0,
        is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`,
      'CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run_at ON scheduled_tasks(next_run_at) WHERE is_active = TRUE',
      'CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_session_id ON scheduled_tasks(session_id)',
    ],
    ['DROP TABLE IF EXISTS scheduled_tasks CASCADE']
  ),
  migration(
    '20260727000001',
    'add_user_id_to_scheduled_tasks',
    [
      "ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS user_id VARCHAR(64) NOT NULL DEFAULT ''",
      'CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_user_id ON scheduled_tasks(user_id)',
    ],
    [
      'DROP INDEX IF EXISTS idx_scheduled_tasks_user_id',
      'ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS user_id',
    ]
  ),
  migration(
    '20260731000001',
    'add_sessions_user_id_index',
    [
      'CREATE INDEX IF NOT EXISTS idx_sessions_user_id_updated ON sessions (user_id, updated_at DESC)',
    ],
    ['DROP INDEX IF EXISTS idx_sessions_user_id_updated']
  ),
  migration(
    '20260803000001',
    'add_delivered_to_agent_task_executions',
    [
      'ALTER TABLE agent_task_executions ADD COLUMN IF NOT EXISTS delivered BOOLEAN NOT NULL DEFAULT false',
      'UPDATE agent_task_executions SET delivered = true WHERE delivered = false AND completed_at IS NOT NULL',
    ],
    ['ALTER TABLE agent_task_executions DROP COLUMN IF EXISTS delivered']
  ),
  migration(
    '20260811000001',
    'expand_sub_exec_status',
    [
      'ALTER TABLE sub_agent_executions DROP CONSTRAINT IF EXISTS ck_sub_exec_status',
      "ALTER TABLE sub_agent_executions ADD CONSTRAINT ck_sub_exec_status CHECK (status IN ('pending','running','completed','failed','interrupted','awaiting_user'))",
    ],
    [
      'ALTER TABLE sub_agent_executions DROP CONSTRAINT IF EXISTS ck_sub_exec_status',
      "ALTER TABLE sub_agent_executions ADD CONSTRAINT ck_sub_exec_status CHECK (status IN ('pending','running','completed','failed'))",
    ]
  ),
  migration(
    '20260828000001',
    'create_task_run_view_states',
    [
      `CREATE TABLE IF NOT EXISTS task_run_view_states (
        user_id VARCHAR(64) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        execution_id VARCHAR(50) NOT NULL REFERENCES agent_task_executions(execution_id) ON DELETE CASCADE,
        seen_at TIMESTAMPTZ,
        collapsed_override BOOLEAN,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, execution_id)
      )`,
    ],
    ['DROP TABLE IF EXISTS task_run_view_states']
  ),
  migration(
    '20260828000002',
    'index_task_run_view_states_execution',
    [
      'CREATE INDEX IF NOT EXISTS idx_task_run_view_states_execution_id ON task_run_view_states (execution_id)',
    ],
    ['DROP INDEX IF EXISTS idx_task_run_view_states_execution_id']
  ),
  migration(
    '20260831000001',
    'add_session_fencing',
    [
      'CREATE SEQUENCE IF NOT EXISTS session_fencing_token_seq AS BIGINT',
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0',
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS fencing_token BIGINT NOT NULL DEFAULT 0',
    ],
    [
      'ALTER TABLE sessions DROP COLUMN IF EXISTS fencing_token',
      'ALTER TABLE sessions DROP COLUMN IF EXISTS revision',
      'DROP SEQUENCE IF EXISTS session_fencing_token_seq',
    ]
  ),
  migration(
    '20260907000001',
    'replace_duplicated_llm_context_with_runtime_state',
    [
      // Runtime 状态格式发生不兼容变更；产品已明确选择清理旧运行数据，不做双写或旧格式兜底。
      'TRUNCATE TABLE sessions, sub_agent_executions, agent_task_executions CASCADE',
      'ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runtime_state JSONB',
      'ALTER TABLE sessions DROP COLUMN IF EXISTS llm_context',
      'ALTER TABLE sub_agent_executions ADD COLUMN IF NOT EXISTS runtime_state JSONB',
      'ALTER TABLE sub_agent_executions DROP COLUMN IF EXISTS llm_context',
      'ALTER TABLE agent_task_executions DROP COLUMN IF EXISTS llm_context',
    ],
    [
      "ALTER TABLE agent_task_executions ADD COLUMN IF NOT EXISTS llm_context JSONB NOT NULL DEFAULT '[]'",
      "ALTER TABLE sub_agent_executions ADD COLUMN IF NOT EXISTS llm_context JSONB NOT NULL DEFAULT '[]'",
      'ALTER TABLE sub_agent_executions DROP COLUMN IF EXISTS runtime_state',
      "ALTER TABLE sessions ADD COLUMN IF NOT EXISTS llm_context JSONB NOT NULL DEFAULT '[]'",
      'ALTER TABLE sessions DROP COLUMN IF EXISTS runtime_state',
    ]
  ),
  migration(
    '20260908000001',
    'add_scheduled_task_execution_fencing',
    [
      'ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS execution_fencing_token BIGINT NOT NULL DEFAULT 0',
    ],
    ['ALTER TABLE scheduled_tasks DROP COLUMN IF EXISTS execution_fencing_token']
  ),
  migration(
    '20260908000002',
    'add_sub_execution_revision',
    [
      // 子执行恢复协议不兼容旧记录；清空后以 revision CAS 作为唯一写入规则。
      'TRUNCATE TABLE sub_agent_executions CASCADE',
      'ALTER TABLE sub_agent_executions ADD COLUMN revision BIGINT NOT NULL DEFAULT 0',
      'ALTER TABLE sub_agent_executions ADD COLUMN pending_interrupt_id VARCHAR(128)',
      "ALTER TABLE sub_agent_executions ADD COLUMN recovery_messages JSONB NOT NULL DEFAULT '[]'",
    ],
    [
      'ALTER TABLE sub_agent_executions DROP COLUMN pending_interrupt_id',
      'ALTER TABLE sub_agent_executions DROP COLUMN recovery_messages',
      'ALTER TABLE sub_agent_executions DROP COLUMN revision',
    ]
  ),
  migration(
    '20260908000003',
    'repair_sub_execution_recovery_columns',
    [
      // 00002 曾在本地环境执行后继续演进；用新版本号修复已经记录旧 00002 的数据库。
      // 仅在恢复列确实缺失时清理不兼容旧行；down 后重放不得再次误删新数据。
      `DO $$
       BEGIN
         IF (
           SELECT COUNT(*) < 3
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'sub_agent_executions'
             AND column_name IN ('revision', 'pending_interrupt_id', 'recovery_messages')
         ) THEN
           TRUNCATE TABLE sub_agent_executions CASCADE;
         END IF;
       END
       $$`,
      'ALTER TABLE sub_agent_executions ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 0',
      'ALTER TABLE sub_agent_executions ADD COLUMN IF NOT EXISTS pending_interrupt_id VARCHAR(128)',
      "ALTER TABLE sub_agent_executions ADD COLUMN IF NOT EXISTS recovery_messages JSONB NOT NULL DEFAULT '[]'",
    ],
    [
      // 该补偿迁移只修复已应用同名旧迁移的数据库；列所有权仍属于 00002，回滚不得重复删除。
      'SELECT 1',
    ]
  ),
  migration(
    '20260911000001',
    'create_session_runs',
    [
      // 会话轨迹事实日志（docs/decisions/2026-09-11-session-trajectory-fact-log.md）：
      // 一个 run 一行 append-only，facts 以 JSONB 追加 user/assistant/tool 三类消息级事实。
      `CREATE TABLE IF NOT EXISTS session_runs (
        run_id VARCHAR(50) PRIMARY KEY,
        session_id VARCHAR(50) NOT NULL,
        user_id VARCHAR(50) NOT NULL DEFAULT '',
        run_index INT NOT NULL,
        provider VARCHAR(50) NOT NULL DEFAULT '',
        model VARCHAR(100) NOT NULL DEFAULT '',
        context_window INT,
        status VARCHAR(20) NOT NULL DEFAULT 'running',
        cancelled_at TIMESTAMPTZ,
        cancelled_by VARCHAR(20),
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        header JSONB,
        facts JSONB NOT NULL DEFAULT '[]',
        schema_version INT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT ck_session_run_status
          CHECK (status IN ('running', 'completed', 'failed', 'cancelled', 'interrupted', 'exhausted')),
        CONSTRAINT ck_session_run_cancelled_by CHECK (cancelled_by IN ('user', 'system'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_session_runs_session_id ON session_runs (session_id, run_index)',
    ],
    ['DROP INDEX IF EXISTS idx_session_runs_session_id', 'DROP TABLE IF EXISTS session_runs']
  ),
])

/** 在执行规范化 SQL migration 时精确保留既有迁移历史。 */
export class PostgresMigrator implements MigrationRunnerPort {
  readonly #database: TransactionalSqlExecutor
  readonly #migrations: readonly Migration[]

  public constructor(
    database: TransactionalSqlExecutor,
    migrations: readonly Migration[] = MIGRATIONS
  ) {
    this.#database = database
    this.#migrations = validateCatalog(migrations)
  }

  public async initialize(signal: AbortSignal): Promise<void> {
    try {
      await this.#database.query(
        `CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
          id BIGSERIAL PRIMARY KEY,
          name VARCHAR,
          group_id BIGINT,
          migrated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )`,
        [],
        signal
      )
    } catch (cause: unknown) {
      throw new Error(`initialize migrations: ${normalizeError(cause).message}`, { cause })
    }
  }

  public async status(signal: AbortSignal): Promise<readonly MigrationStatus[]> {
    await this.initialize(signal)
    const applied = await this.#loadApplied(this.#database, signal)
    const appliedByName = new Map(
      applied.map((item): readonly [string, AppliedMigration] => [item.name, item])
    )
    return this.#migrations.map((migration): MigrationStatus => {
      const history = appliedByName.get(migration.name)
      return history === undefined
        ? { name: migration.name, comment: migration.comment, status: 'pending' }
        : {
            name: migration.name,
            comment: migration.comment,
            status: 'applied',
            groupId: history.groupId,
            migratedAt: history.migratedAt,
          }
    })
  }

  public async up(signal: AbortSignal): Promise<MigrationGroup> {
    await this.initialize(signal)
    return this.#database.transaction(signal, async (transaction): Promise<MigrationGroup> => {
      await acquireMigrationLock(transaction, signal)
      const applied = await this.#loadApplied(transaction, signal)
      const pending = this.#migrations.slice(applied.length)
      if (pending.length === 0) return { groupId: 0, migrationNames: [] }
      const groupId =
        applied.reduce((highest, item): number => Math.max(highest, item.groupId), 0) + 1
      for (const migration of pending) {
        await runMigrationStatements(transaction, migration, 'up', signal)
        await transaction.query(
          `INSERT INTO ${HISTORY_TABLE} (name, group_id, migrated_at)
           VALUES ($1, $2, CURRENT_TIMESTAMP)`,
          [migration.name, groupId],
          signal
        )
      }
      return { groupId, migrationNames: pending.map((migration): string => migration.name) }
    })
  }

  public async down(signal: AbortSignal): Promise<MigrationGroup> {
    await this.initialize(signal)
    return this.#database.transaction(signal, async (transaction): Promise<MigrationGroup> => {
      await acquireMigrationLock(transaction, signal)
      const applied = await this.#loadApplied(transaction, signal)
      if (applied.length === 0) return { groupId: 0, migrationNames: [] }
      const groupId = applied.reduce((highest, item): number => Math.max(highest, item.groupId), 0)
      const names = new Set(
        applied.filter((item): boolean => item.groupId === groupId).map((item): string => item.name)
      )
      const rollback = this.#migrations.filter((item): boolean => names.has(item.name)).toReversed()
      for (const migration of rollback) {
        await runMigrationStatements(transaction, migration, 'down', signal)
        await transaction.query(
          `DELETE FROM ${HISTORY_TABLE} WHERE name = $1`,
          [migration.name],
          signal
        )
      }
      return { groupId, migrationNames: rollback.map((migration): string => migration.name) }
    })
  }

  async #loadApplied(
    executor: SqlExecutor,
    signal: AbortSignal
  ): Promise<readonly AppliedMigration[]> {
    let rows: readonly unknown[]
    try {
      const result = await executor.query(
        `SELECT id, name, group_id, migrated_at FROM ${HISTORY_TABLE} ORDER BY id ASC`,
        [],
        signal
      )
      rows = result.rows
    } catch (cause: unknown) {
      throw new Error(`read migration history: ${normalizeError(cause).message}`, { cause })
    }
    const applied = rows.map(parseHistoryRow)
    validateHistory(applied, this.#migrations)
    return applied
  }
}

function migration(
  name: string,
  comment: string,
  up: readonly string[],
  down: readonly string[]
): Migration {
  return Object.freeze({ name, comment, up: Object.freeze(up), down: Object.freeze(down) })
}

function validateCatalog(migrations: readonly Migration[]): readonly Migration[] {
  const names = new Set<string>()
  let previous = ''
  for (const item of migrations) {
    if (!/^\d{14}$/u.test(item.name)) throw new Error(`invalid migration name: ${item.name}`)
    if (names.has(item.name)) throw new Error(`duplicate migration name: ${item.name}`)
    if (previous !== '' && item.name <= previous) throw new Error('migration catalog is not sorted')
    if (item.up.length === 0 || item.down.length === 0) {
      throw new Error(`migration ${item.name} must define up and down statements`)
    }
    names.add(item.name)
    previous = item.name
  }
  return migrations
}

function parseHistoryRow(row: unknown): AppliedMigration {
  const parsed = historyRowSchema.safeParse(row)
  if (!parsed.success) throw new Error('invalid migration history row', { cause: parsed.error })
  return {
    id: parsed.data.id,
    name: parsed.data.name,
    groupId: parsed.data.group_id,
    migratedAt: parsed.data.migrated_at,
  }
}

function validateHistory(
  applied: readonly AppliedMigration[],
  migrations: readonly Migration[]
): void {
  const seen = new Set<string>()
  for (const [index, item] of applied.entries()) {
    if (seen.has(item.name)) throw new Error(`invalid migration history: duplicate ${item.name}`)
    const expected = migrations[index]
    if (expected === undefined) throw new Error(`invalid migration history: unknown ${item.name}`)
    if (item.name !== expected.name) {
      throw new Error(
        `invalid migration history: expected ${expected.name} at position ${String(index + 1)}, got ${item.name}`
      )
    }
    seen.add(item.name)
  }
}

async function acquireMigrationLock(executor: SqlExecutor, signal: AbortSignal): Promise<void> {
  await executor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADVISORY_LOCK_NAME], signal)
}

async function runMigrationStatements(
  executor: SqlExecutor,
  migrationItem: Migration,
  direction: 'up' | 'down',
  signal: AbortSignal
): Promise<void> {
  try {
    const statements = direction === 'up' ? migrationItem.up : migrationItem.down
    for (const statement of statements) await executor.query(statement, [], signal)
  } catch (cause: unknown) {
    throw new Error(
      `migration ${migrationItem.name} ${direction} failed: ${normalizeError(cause).message}`,
      { cause }
    )
  }
}
