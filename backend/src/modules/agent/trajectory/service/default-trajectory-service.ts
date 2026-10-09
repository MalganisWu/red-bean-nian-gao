import { PROCESS_STARTED_AT } from '../../../../shared/lifecycle/process-start.js'
import type { SessionRepository } from '../../session/repository/port/session-repository.port.js'
import type { SubExecutionRepository } from '../../subagent/repository/port/sub-execution-repository.port.js'
import type { RunFactRepository } from '../../run-facts/port/run-fact-repository.port.js'
import {
  RUN_FACT_STORE_ERROR_CODES,
  RunFactStoreError,
} from '../../run-facts/model/run-fact-store-error.js'
import {
  SessionNotFoundError,
  SESSION_STORE_ERROR_CODES,
  SessionStoreError,
} from '../../session/model/session.js'
import type { SessionTrajectory } from '../model/trajectory.js'
import { projectFactsTrajectory } from './trajectory-fact-projector.js'
import { projectTrajectory } from './trajectory-projector.js'

export interface GetTrajectoryQuery {
  readonly sessionId: string
  readonly userId: string
}

/** 事实日志降级时的诊断出口；生产默认实现为 infra Logger。 */
export interface TrajectoryDegradationLogger {
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
}

/**
 * 会话轨迹查询用例（只读审计视图），内部 1:1 实现（无独立 Port），由 `agent.module.ts` 组装，
 * Controller 直接依赖本类。数据源二分（R10）：会话存在 session_runs 记录时，token/请求/终态
 * 维度从事实日志投影；无 run 记录的旧会话回退到 display_messages + sub_agent_executions 投影。
 *
 * 降级语义：审计视图不因脏数据整页报错——事实日志不可读（历史脏数据 / 未来版本记录，R9
 * 拒绝重放）时整体回退 G0 投影并记录诊断；基础设施故障照常上抛。
 */
export class DefaultTrajectoryService {
  readonly #sessions: SessionRepository
  readonly #subExecutions: SubExecutionRepository
  readonly #runFacts: RunFactRepository
  readonly #logger: TrajectoryDegradationLogger | undefined

  public constructor(
    sessions: SessionRepository,
    subExecutions: SubExecutionRepository,
    runFacts: RunFactRepository,
    logger?: TrajectoryDegradationLogger
  ) {
    this.#sessions = sessions
    this.#subExecutions = subExecutions
    this.#runFacts = runFacts
    this.#logger = logger
  }

  /** 读取会话轨迹；会话不存在抛 SessionNotFoundError（Controller 映射为 404）。 */
  public async get(query: GetTrajectoryQuery, signal: AbortSignal): Promise<SessionTrajectory> {
    let session
    try {
      session = await this.#sessions.getById(query.sessionId, query.userId, signal)
    } catch (cause: unknown) {
      if (
        cause instanceof SessionStoreError &&
        cause.code === SESSION_STORE_ERROR_CODES.NOT_FOUND
      ) {
        throw new SessionNotFoundError({ cause })
      }
      throw cause
    }
    let runs
    try {
      runs = await this.#runFacts.listBySession(query.sessionId, signal)
    } catch (cause: unknown) {
      if (
        cause instanceof RunFactStoreError &&
        cause.code === RUN_FACT_STORE_ERROR_CODES.FACTS_UNREADABLE
      ) {
        this.#logger?.warn('会话轨迹事实日志不可读，已回退 display_messages 投影', {
          session_id: query.sessionId,
          reason: cause.message,
        })
        return projectTrajectory({
          sessionId: session.id,
          messages: session.displayMessages,
          subExecutions: await this.#subExecutions.listBySession(query.sessionId, signal),
        })
      }
      throw cause
    }
    if (runs.length > 0) {
      return projectFactsTrajectory({
        sessionId: session.id,
        runs,
        subExecutions: await this.#subExecutions.listBySession(query.sessionId, signal),
        messages: session.displayMessages,
        // 进程启动时刻用于区分仍在执行的 run 与崩溃遗留的 running 行。
        processStartedAt: PROCESS_STARTED_AT,
      })
    }
    return projectTrajectory({
      sessionId: session.id,
      messages: session.displayMessages,
      subExecutions: await this.#subExecutions.listBySession(query.sessionId, signal),
    })
  }
}
