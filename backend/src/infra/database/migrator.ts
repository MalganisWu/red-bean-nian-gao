import { z } from 'zod'
import { normalizeError } from '../../shared/errors/normalize-error.js'

import type { SqlExecutor, TransactionalSqlExecutor } from './postgres.js'

/** 迁移历史表名；所有历史读写都走这一张表，改名对既有库即为不兼容变更。 */
const HISTORY_TABLE = 'schema_migrations'

/**
 * advisory 锁名。
 *
 * 取固定的应用级字符串而不是某个表的行标识，是为了让「同一次迁移」的所有并发实例争用同一把锁；
 * 它经 `hashtext()` 转成整数后交给 `pg_advisory_xact_lock`，因此锁随事务结束自动释放。
 */
const ADVISORY_LOCK_NAME = 'red-bean-nian-gao:schema_migrations'

/** 一条迁移；`name` 是 14 位时间戳，`up`/`down` 必须成对给出且都非空。 */
export interface Migration {
  /** 14 位时间戳，同时充当历史行标识、目录排序依据与唯一性依据。 */
  readonly name: string
  /** 供人和 CLI 阅读的说明，不参与 SQL 执行。 */
  readonly comment: string
  /** 正向语句，整体在同一个事务里按数组顺序执行。 */
  readonly up: readonly string[]
  /** 回滚语句，必须与 `up` 成对且非空，否则目录校验不通过。 */
  readonly down: readonly string[]
}

/** 一次 up/down 的批次；同批语句视为一个可整体回滚的单位。 */
export interface MigrationGroup {
  /** 分组号，等于历史中最大分组号加一；未发生变更的空批次为 0。 */
  readonly groupId: number
  /** 本批涉及的迁移名，按目录定义顺序排列；空批次为空数组。 */
  readonly migrationNames: readonly string[]
}

/** 单条迁移的当前状态；`pending` 时 `groupId`/`migratedAt` 不会出现。 */
export interface MigrationStatus {
  /** 迁移名，与冻结目录中的条目一一对应。 */
  readonly name: string
  /** 目录为该迁移写下的说明，透传自 `Migration.comment`。 */
  readonly comment: string
  /** 是否已应用；`pending` 表示历史表里还没有这一条。 */
  readonly status: 'pending' | 'applied'
  /** 已应用时所属的分组号；`pending` 时为 `undefined`。 */
  readonly groupId?: number | undefined
  /** 已应用时的落地时间；`pending` 时为 `undefined`。 */
  readonly migratedAt?: Date | undefined
}

/** 应用启动所需的数据库迁移端口；默认实现为 `PostgresMigrator`。 */
export interface DatabaseMigrationGatePort {
  /**
   * 应用所有尚未执行的迁移，供应用启动期调用。
   * @param signal - 取消信号，透传给事务内的所有查询
   * @returns 本次应用的批次；没有 pending 时返回分组号为 0 的空批次
   */
  up(signal: AbortSignal): Promise<MigrationGroup>
  /**
   * 读取目录中每条迁移的当前状态，只读且可重复调用。
   * @param signal - 取消信号，透传给底层查询
   * @returns 每条目录迁移的状态；未在历史中出现过的条目为 `pending`
   */
  status(signal: AbortSignal): Promise<readonly MigrationStatus[]>
}

/** migrate CLI 所需的完整迁移端口；默认实现为 `PostgresMigrator`。 */
export interface MigrationRunnerPort extends DatabaseMigrationGatePort {
  /**
   * 回滚最近一个分组，按目录定义的逆序执行。
   * @param signal - 取消信号，透传给事务内的所有查询
   * @returns 本次回滚的批次；历史为空时返回分组号为 0 的空批次
   */
  down(signal: AbortSignal): Promise<MigrationGroup>
}

/** 历史表中的一行已应用迁移；只在迁移器内部流转，不出现在对外契约里。 */
interface AppliedMigration {
  /** 历史行自增主键；读取顺序即写入顺序。 */
  readonly id: number
  /** 迁移名，必须与目录中对应位置的条目一致。 */
  readonly name: string
  /** 该行写入时所归属的分组号。 */
  readonly groupId: number
  /** 该行落地进历史表的时间。 */
  readonly migratedAt: Date
}

/**
 * 历史表数值列的形状。
 *
 * pg 的 BIGINT 可能以字符串返回，所以先把字符串数字归一成 `number` 再校验安全整数——
 * 宁可在这里判失败，也不要让一个超出安全范围的 id 悄悄失去精度。
 */
const safeIntegerSchema = z
  .union([z.number().int(), z.string().regex(/^\d+$/u).transform(Number)])
  .refine(Number.isSafeInteger, 'must be a safe integer')

/** 历史表一行的解析模式；`name` 必须是 14 位时间戳，`migrated_at` 必须是 `Date`。 */
const historyRowSchema = z.object({
  id: safeIntegerSchema,
  name: z.string().regex(/^\d{14}$/u),
  group_id: safeIntegerSchema,
  migrated_at: z.date(),
})

/**
 * 冻结的迁移目录：**只能追加，不得回头修改已发布的条目**。
 *
 * 启动时 `validateCatalog` 校验命名、唯一性与严格升序，`validateHistory` 还要求实际历史
 * 是这份目录的**严格前缀**。因此改动历史中某条迁移的顺序或名字不会静默生效，
 * 而是让进程在启动期直接失败——这正是「各环境 schema 不许悄悄分叉」这条纪律的执行者。
 */
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
      // 会话轨迹事实日志（设计见 docs/design/session/session-trajectory.md）：
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
  /** 事务与查询的执行入口；由构造函数注入，迁移器不自己建连接。 */
  readonly #database: TransactionalSqlExecutor
  /** 已通过 `validateCatalog` 校验的迁移目录；构造完成后不再变化。 */
  readonly #migrations: readonly Migration[]

  public constructor(
    database: TransactionalSqlExecutor,
    migrations: readonly Migration[] = MIGRATIONS
  ) {
    this.#database = database
    this.#migrations = validateCatalog(migrations)
  }

  /**
   * 建立迁移历史表（幂等，`CREATE TABLE IF NOT EXISTS`），让后续读写历史有表可依。
   * 这是 `status` / `up` / `down` 的共同前置：它们各自先调用本方法，而不是假设调用方已经建过表。
   * 失败时统一包装成 `initialize migrations` 前缀的错误，便于区分「建表失败」与后续步骤的失败。
   * @param signal - 取消信号，透传给底层查询
   */
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

  /**
   * 列出冻结目录中每条迁移的当前状态，供 CLI 与健康检查展示。
   * 只读：它不会执行任何 DDL 或写入历史表，因此可以安全地在启动前重复调用。
   * 输出顺序恒等于目录定义顺序，与数据库里的历史行序无关。
   * 读取到与实际目录不符的历史时会抛错——这表示各环境的 schema 已经分叉，必须人工介入。
   * @param signal - 取消信号，透传给底层查询
   * @returns 每条目录迁移的状态；未在历史中出现过的条目为 `pending`
   */
  public async status(signal: AbortSignal): Promise<readonly MigrationStatus[]> {
    await this.initialize(signal)
    const applied = await this.#loadApplied(this.#database, signal)
    const appliedByName = new Map(
      applied.map((item): readonly [string, AppliedMigration] => [item.name, item])
    )
    return this.#migrations.map((migration): MigrationStatus =>
      toMigrationStatus(migration, appliedByName)
    )
  }

  /**
   * 应用所有尚未执行的迁移，整体在一个事务里完成。
   * 事务内**先取 advisory lock 再读历史**，两个实例并发启动时因此不会各自算出同一批 pending 并重复执行；
   * 任一条语句失败都会回滚整个事务，不会留下「跑了一半」的 schema。
   * @param signal - 取消信号，透传给事务内的所有查询
   * @returns 本次应用的批次；没有 pending 时返回 `groupId` 为 0、`migrationNames` 为空的空批次
   */
  public async up(signal: AbortSignal): Promise<MigrationGroup> {
    await this.initialize(signal)
    /*
     * 整个过程在一个事务里，且**先取 advisory lock 再读历史**——顺序不能反。
     * 先读后锁的话，两个实例可能读到同一份历史，各自算出同一批 pending，然后双双执行。
     * 锁在整个事务结束时自动释放（pg_advisory_xact_lock 的语义）。
     */
    return this.#database.transaction(signal, (transaction): Promise<MigrationGroup> =>
      this.#applyPendingMigrations(transaction, signal)
    )
  }

  /**
   * 在事务内按目录顺序应用尚未执行的迁移，并记录本次分组号。
   * @param transaction - 事务内的执行器；语句与历史写入必须共用它，否则会跑到事务之外
   * @param signal - 取消信号，透传给事务内的所有查询
   * @returns 本次应用的批次；没有 pending 时返回分组号为 0 的空批次
   */
  async #applyPendingMigrations(
    transaction: SqlExecutor,
    signal: AbortSignal
  ): Promise<MigrationGroup> {
    await acquireMigrationLock(transaction, signal)
    const applied = await this.#loadApplied(transaction, signal)
    // 已应用的是冻结目录的前缀（validateHistory 保证），所以「剩下没跑的」就是后缀切片。
    const pending = this.#migrations.slice(applied.length)
    if (pending.length === 0) return { groupId: 0, migrationNames: [] }
    // 分组号取「历史里最大的 + 1」，因此一次 up 是一个可以整体回滚的单位。
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
  }

  /**
   * 回滚**最近一个分组**，且按定义顺序的逆序执行。
   * 逆序是必须的：后面的 migration 可能依赖前面建的表/列，正序回滚会先删掉依赖方。
   * `toReversed()` 不改原数组——冻结目录必须保持原样。
   * @param signal - 取消信号，透传给事务内的所有查询
   * @returns 本次回滚的批次；历史为空时返回 `groupId` 为 0、`migrationNames` 为空的空批次
   */
  public async down(signal: AbortSignal): Promise<MigrationGroup> {
    await this.initialize(signal)
    return this.#database.transaction(signal, (transaction): Promise<MigrationGroup> =>
      this.#rollbackLatestGroup(transaction, signal)
    )
  }

  /**
   * 在事务内按目录定义的逆序回滚最近一个分组。
   * @param transaction - 事务内的执行器；语句与历史删除必须共用它，否则会跑到事务之外
   * @param signal - 取消信号，透传给事务内的所有查询
   * @returns 本次回滚的批次；历史为空时返回分组号为 0 的空批次
   */
  async #rollbackLatestGroup(
    transaction: SqlExecutor,
    signal: AbortSignal
  ): Promise<MigrationGroup> {
    await acquireMigrationLock(transaction, signal)
    const applied = await this.#loadApplied(transaction, signal)
    if (applied.length === 0) return { groupId: 0, migrationNames: [] }
    const groupId = applied.reduce((highest, item): number => Math.max(highest, item.groupId), 0)
    // 用 Set 存名字再过滤冻结目录，是为了让回滚顺序由**目录定义顺序**决定，
    // 而不是由历史表的行序决定；两者一致，但前者才是权威。
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
  }

  /**
   * 按写入顺序（`id ASC`）读出历史；顺序本身就是信息，`validateHistory` 依赖它。
   * @param executor - 用于读取历史的执行器；事务内调用时必须是事务执行器
   * @param signal - 取消信号，透传给查询
   * @returns 已应用迁移，按历史表写入顺序排列
   */
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

/**
 * 造一条冻结的迁移：条目本身与 up/down 语句数组都 `Object.freeze`。
 *
 * 冻结是为了让「目录只能追加、不得回头修改」这条纪律在运行期也有兜底——
 * 若有人试图就地改写某条语句，得到的会是一个无声失败的赋值，而不是悄悄改变的迁移历史。
 * @param name - 14 位时间戳，决定目录顺序
 * @param comment - 该迁移的说明，供 CLI 与状态查询展示
 * @param up - 正向语句，按数组顺序执行，必须非空
 * @param down - 回滚语句，必须与 up 成对且非空
 * @returns 冻结后的迁移对象
 */
function migration(
  name: string,
  comment: string,
  up: readonly string[],
  down: readonly string[]
): Migration {
  return Object.freeze({ name, comment, up: Object.freeze(up), down: Object.freeze(down) })
}

/**
 * 启动时校验冻结目录自身的自洽性：14 位时间戳命名、不重复、严格升序、up/down 都非空。
 * 这些错误在编译期看不出来（目录是字面量数组），但一旦成立，后续每一次迁移都会带着它跑，
 * 所以宁可让进程起不来。
 * @param migrations - 待校验的迁移目录
 * @returns 原样返回的目录；只有校验通过才有返回值，否则直接抛错
 */
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

/**
 * 把一条目录迁移与已应用历史合并成对外状态；历史里没有就是 pending。
 * @param migration - 目录中的一条迁移，提供 name 与 comment
 * @param appliedByName - 已应用历史，按迁移名索引
 * @returns 该迁移的对外状态；历史里存在即为 applied，否则为 pending
 */
function toMigrationStatus(
  migration: Migration,
  appliedByName: ReadonlyMap<string, AppliedMigration>
): MigrationStatus {
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
}

/**
 * 把历史表的原始行解析成内部形状。
 *
 * 解析失败即抛错，不做容错降级——读不懂的历史行意味着库里的数据与这份代码已经对不上，
 * 此时继续迁移只会让分叉更大。
 * @param row - 数据库返回的原始行
 * @returns 校验后的已应用迁移记录
 */
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

/**
 * 校验历史必须是冻结目录的**严格前缀**：逐位比对名字、不允许多、不允乱序。
 *
 * 这条约束是「不修改已执行的 migration」这条纪律的执行者。只要有人回头改了历史中某条
 * migration 的名字或顺序，这里就会在启动时炸掉，而不是让不同环境的 schema 悄悄分叉。
 * @param applied - 从历史表读出的记录，按写入顺序排列
 * @param migrations - 冻结目录，作为逐位比对的基准
 */
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

/**
 * 在事务内取 advisory 锁，把同一数据库上的并发迁移串行化。
 *
 * 用 `pg_advisory_xact_lock` 而非会话级锁：它随事务结束自动释放，既不需要显式解锁，
 * 也不会在连接复用后把锁留给下一个使用者。
 * @param executor - 事务内的执行器；锁必须取在事务所用的那一条连接上
 * @param signal - 取消信号，透传给取锁查询
 */
async function acquireMigrationLock(executor: SqlExecutor, signal: AbortSignal): Promise<void> {
  await executor.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADVISORY_LOCK_NAME], signal)
}

/**
 * 按顺序执行一条迁移某个方向的全部语句，并给失败补上「哪条迁移、哪个方向」的上下文。
 *
 * 这里不吞异常也不做部分重试：失败会向上冒泡给事务，由事务整体回滚，避免留下半跑的 schema。
 * @param executor - 事务内的执行器；所有语句都必须共用它，否则会跑到事务之外
 * @param migrationItem - 要执行的迁移，函数内只读它的语句数组
 * @param direction - 执行正向还是回滚，决定取 up 还是 down
 * @param signal - 取消信号，透传给每条语句的查询
 */
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
