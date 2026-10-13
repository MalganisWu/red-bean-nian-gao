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

/** 轨迹查询入参；必须带 userId，越权访问与不存在收敛到同一条 404。 */
export interface GetTrajectoryQuery {
  /** 目标会话标识，取自路径参数且已过契约校验。 */
  readonly sessionId: string
  /** 当前登录用户，决定归属范围；越权与不存在收敛为同一 404。 */
  readonly userId: string
}

/** 事实日志降级时的诊断出口；生产默认实现为 infra Logger。 */
export interface TrajectoryDegradationLogger {
  /**
   * 记录一条降级诊断；只在审计视图被迫回退投影时调用，不是常规日志出口。
   *
   * @param message - 人类可读的中文诊断信息，说明降级原因。
   * @param fields - 附加上下文字段（如 session_id、reason）；缺省表示无额外上下文。
   */
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void
}

/**
 * 会话轨迹查询用例（只读审计视图），内部 1:1 实现（无独立 Port），由 `agent.module.ts` 组装，
 * Controller 直接依赖本类。数据源二分（R10）：会话存在 session_runs 记录时，token/请求/终态
 * 维度从事实日志投影；无 run 记录的旧会话回退到 display_messages + sub_agent_executions 投影。
 *
 * 降级语义：审计视图不因脏数据整页报错——事实日志不可读（历史脏数据 / 未来版本记录，R9
 * 拒绝重放）时整体回退 G0 投影并记录诊断；基础设施故障照常上抛。
 *
 * 数据源选择：有 run 记录走事实投影，无记录或事实不可读回退展示消息投影，
 * 两条路径产出的 `SessionTrajectory` 形状一致，调用方无需分支。
 */
export class DefaultTrajectoryService {
  /** 会话仓储；提供会话存在性校验与展示消息，是两条投影路径的共同起点。 */
  readonly #sessions: SessionRepository
  /** 子执行仓储；为子 Agent 段并入 token、耗时与结果。 */
  readonly #subExecutions: SubExecutionRepository
  /** 事实日志仓储；有 run 记录时优先作为投影数据源。 */
  readonly #runFacts: RunFactRepository
  /** 降级诊断出口；缺省时静默降级，不影响返回结果。 */
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

  /**
   * 读取会话轨迹；会话不存在抛 SessionNotFoundError（Controller 映射为 404）。
   * 会话存在但事实日志不可读时降级为展示消息投影，不整页报错。
   *
   * @param query - 查询条件；userId 参与归属校验，越权与不存在收敛为同一 404。
   * @param signal - 请求取消信号，串行透传给会话、事实与子执行三处仓储。
   * @returns 会话轨迹；投影口径随数据源不同，但字段形状对调用方保持一致。
   */
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
