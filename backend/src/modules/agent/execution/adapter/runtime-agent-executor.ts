import {
  AgentRuntime,
  RuntimeExecutionError,
  serializeCheckpoint,
  type AgentRequest,
  type ResumeRequest,
} from 'red-bean-qing-tuan'
import { type MessageHook, type RawMessage, type RuntimeContext } from 'red-bean-qing-tuan/pipeline'
import type { TracerPort } from '../../../../shared/observability/tracer.js'

import type {
  AgentExecutionCommand,
  AgentExecutionMessageObserver,
  AgentExecutionOutcome,
  AgentExecutionPort,
} from '../port/agent-executor.js'
import { EXECUTION_COMMAND_KINDS, EXECUTION_OUTCOME_STATUSES } from '../port/agent-executor.js'
import type { StoredRuntimeState } from '../model/runtime-state.js'
import {
  fromRuntimeMessage,
  fromRuntimeMessages,
  toRuntimeMessages,
} from './runtime-message-mapper.js'
import { fromRuntimeEvent } from './runtime-event-mapper.js'
import { parseStoredRuntimeState } from './runtime-state-codec.js'
import { optionalField } from '../../../../shared/object/optional-field.js'

/**
 * 将业务执行命令适配到 SDK；**所有 SDK DTO 转换都收口在此处**。
 *
 * 这条约束是结构性的：产品代码只能经由本文件碰 `red-bean-qing-tuan` 的白名单入口，
 * 别处必须依赖业务自有类型。好处是 SDK 升级时的改动面被限制在这几个 mapper 文件里
 * （见同目录的 runtime-message/event/state mapper）。
 *
 * 失败语义：SDK 抛出的 `RuntimeExecutionError` 携带已产生的 result 快照，本适配器
 * 不丢弃它——映射为带 error 的宿主结果，让上层仍能持久化部分进展。
 */
export class RuntimeAgentExecutor implements AgentExecutionPort {
  /** 平台 Tracer；缺省时整段执行不产出 span，其余行为不变。 */
  readonly #tracer: TracerPort | undefined

  public constructor(tracer?: TracerPort) {
    this.#tracer = tracer
  }

  /**
   * 跑一次执行。**每次调用都新建一个 `AgentRuntime`**，且必在 finally 中关闭：
   * Runtime 的插件、能力图与生命周期计数器都是按实例持有的，跨命令复用会让上一次运行的
   * 取消计数、消息 hook 与资源登记串到下一次；不复用也就意味着「一次运行一个实例」是这里的隐含约定。
   * @param command 业务执行命令，承载 session/run 身份、执行定义、恢复状态与观察者
   * @param signal 取消信号，透传给 SDK 作为本次运行的取消来源
   * @returns 宿主执行结果；SDK 抛 `RuntimeExecutionError` 时不丢结果快照，映射为带 error 的失败结果
   */
  public async execute(
    command: AgentExecutionCommand,
    signal: AbortSignal
  ): Promise<AgentExecutionOutcome> {
    const runtime = new AgentRuntime({
      model: command.definition.model,
      toolSchemas: command.definition.tools,
      toolDispatcher: command.definition.dispatcher,
      systemPrompt: command.definition.systemPrompt,
      modelParams: command.definition.modelParams,
      runtimeConfig: command.definition.runtimeConfig,
      ...(command.eventSink === undefined
        ? {}
        : {
            eventSink: {
              publish: (event): void => command.eventSink?.publish(fromRuntimeEvent(event)),
            },
          }),
      ...(command.messageObserver === undefined
        ? {}
        : { messageHook: new ObserverMessageHook(command.messageObserver) }),
    })
    const parsedState =
      command.state === undefined ? undefined : parseStoredRuntimeState(command.state)
    // 增量恢复消息（上次崩溃后未入主快照）按消息键去重合并进状态，避免重复消费。
    const state =
      parsedState === undefined
        ? undefined
        : {
            ...parsedState,
            messages: appendWithoutOverlap(
              parsedState.messages,
              toRuntimeMessages(command.recoveryMessages ?? [])
            ),
          }
    async function run(): Promise<AgentExecutionOutcome> {
      try {
        // resume 分支才携带 interruptId/response 语义（回答询问卡片/中断恢复）；
        // run 分支传 messages，且仅在无显式 state 但有 recovery 时把增量消息作为 history。
        const resumeRequest: ResumeRequest = {
          threadId: command.sessionId,
          userId: command.userId,
          requestId: command.runId,
          traceId: command.traceId,
          interruptId: command.interruptId ?? '',
          response: command.response ?? '',
          ...optionalField('state', state),
        }
        const runRequest: AgentRequest = {
          threadId: command.sessionId,
          userId: command.userId,
          requestId: command.runId,
          traceId: command.traceId,
          messages: toRuntimeMessages(command.messages ?? []),
          ...(state === undefined && (command.recoveryMessages?.length ?? 0) > 0
            ? { history: toRuntimeMessages(command.recoveryMessages ?? []) }
            : {}),
          ...optionalField('state', state),
        }
        const result =
          command.kind === EXECUTION_COMMAND_KINDS.RESUME
            ? await runtime.resume(resumeRequest, signal)
            : await runtime.run(runRequest, signal)
        return outcome(result)
      } catch (cause: unknown) {
        // SDK 执行失败但留下结果快照：映射为失败结果而非异常上抛，上层可持久化部分进展。
        if (!(cause instanceof RuntimeExecutionError)) throw cause
        return outcome(cause.result, cause)
      } finally {
        // 无论成败都关闭 SDK 运行实例（5s 预算），挂起的资源不能泄漏。
        await runtime.close(AbortSignal.timeout(5_000))
      }
    }
    // 观测：整段执行包在一个 agent.execute span 里，落 session/run/trace 维度。
    if (this.#tracer === undefined) return run()
    const span = this.#tracer.start({
      name: 'agent.execute',
      attributes: [
        { key: 'session.id', value: command.sessionId },
        { key: 'run.id', value: command.runId },
        { key: 'trace.id', value: command.traceId },
      ],
    })
    try {
      const result = await span.within(run)
      span.end(result.error)
      return result
    } catch (cause: unknown) {
      span.end(cause instanceof Error ? cause : new Error(String(cause)))
      throw cause
    }
  }
}

/**
 * 把 SDK 的三类消息回调统一转成宿主观察者的一次 `observe`。
 * 刻意忽略 `RuntimeContext`：宿主观察者由构造期注入，已经绑定了它需要的运行身份，
 * 再传一次 context 只会让两个来源有机会不一致。
 * 三类回调都走同一条路径，是因为宿主要做的是「把消息落库」，与角色无关。
 */
class ObserverMessageHook implements MessageHook {
  /** 宿主观察者；由构造期注入，已绑定它需要的运行身份。 */
  readonly #observer: AgentExecutionMessageObserver

  public constructor(observer: AgentExecutionMessageObserver) {
    this.#observer = observer
  }

  /**
   * 宿主侧用户消息回调：把 SDK 的 user 消息映射为产品消息后交给观察者落库。
   * 三类回调共用同一条路径，因为宿主要做的只是「把消息落库」，与角色无关。
   * @param _context SDK 运行上下文；此处刻意忽略——观察者在构造期已绑定运行身份，再传一次只会让两个来源有机会不一致
   * @param message SDK 原始消息，经 fromRuntimeMessage 转为产品域消息
   * @param signal 取消信号，透传给观察者；运行取消时应中断本次写入
   */
  public onUserMessage(
    _context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.#observer.observe(fromRuntimeMessage(message), signal)
  }

  /**
   * 宿主侧助手消息回调：把 SDK 的 assistant 消息映射为产品消息后交给观察者。
   * 与用户/工具消息走同一次 observe，宿主的落库逻辑无需按角色分叉。
   * @param _context SDK 运行上下文；刻意忽略，理由同 onUserMessage
   * @param message SDK 原始消息，经 fromRuntimeMessage 转为产品域消息
   * @param signal 取消信号，透传给观察者
   */
  public onAssistantMessage(
    _context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.#observer.observe(fromRuntimeMessage(message), signal)
  }

  /**
   * 宿主侧工具消息回调：把 SDK 的 tool 结果消息映射为产品消息后交给观察者。
   * 工具调用可能耗时较长，写入依赖同一个 signal，取消时写入会一并停下。
   * @param _context SDK 运行上下文；刻意忽略，理由同 onUserMessage
   * @param message SDK 原始消息，经 fromRuntimeMessage 转为产品域消息
   * @param signal 取消信号，透传给观察者
   */
  public onToolMessage(
    _context: RuntimeContext,
    message: RawMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.#observer.observe(fromRuntimeMessage(message), signal)
  }
}

/**
 * 崩溃恢复去重：checkpoint 已含 base，增量 suffix 头部可能与 base 尾部重叠（消息已入库），
 * 按完整消息键找到最大重叠后缀后拼接，避免重复消息进入下一次运行。
 * @param base 已有快照中的消息序列，作为拼接的左侧基准
 * @param suffix 待并入的增量消息；其前缀可能已在 base 尾部出现
 * @returns 去重拼接后的新数组；无重叠时等价于 base 直接接上 suffix
 */
function appendWithoutOverlap(
  base: readonly RawMessage[],
  suffix: readonly RawMessage[]
): RawMessage[] {
  const max = Math.min(base.length, suffix.length)
  let overlap = 0
  for (let size = max; size > 0; size -= 1) {
    const left = base.slice(base.length - size).map(serializeMessageKey)
    const right = suffix.slice(0, size).map(serializeMessageKey)
    if (left.every((value, index): boolean => value === right[index])) {
      overlap = size
      break
    }
  }
  return [...base, ...suffix.slice(overlap)]
}

/**
 * 把单条消息序列化为去重比较用的键。
 * 用整体 JSON 而非某个 id 字段：RawMessage 没有稳定主键，工具调用等嵌套字段任一不同都应算作不同消息。
 * @param message 待序列化的 SDK 消息
 * @returns 可用于相等比较的 JSON 字符串
 */
function serializeMessageKey(message: RawMessage): string {
  return JSON.stringify(message)
}

/**
 * 把 SDK 结果投影为宿主执行结果：checkpoint 序列化为 StoredRuntimeState，
 * 状态语义按 SDK status 分发（completed / suspended(中断) / cancelled / exhausted / failed）。
 * @param result SDK 返回的结果快照，携带状态、输出、消息与 checkpoint
 * @param executionError SDK 抛出的原始错误，仅在失败分支作为 error 的 cause；缺省时按 finishReason 另行构造
 * @returns 宿主可辨识联合结果；suspended 分支若缺 interrupt 会降级为 failed，避免上层拿到非法组合
 */
function outcome(
  result: {
    readonly status: AgentExecutionOutcome['status']
    readonly output: string
    readonly messages: readonly RawMessage[]
    readonly checkpoint: Parameters<typeof serializeCheckpoint>[0]
    readonly tokensUsed: number
    readonly finishReason: string
  },
  executionError?: Error
): AgentExecutionOutcome {
  const state: StoredRuntimeState = {
    engine: 'qing-tuan',
    version: result.checkpoint.version,
    payload: serializeCheckpoint(result.checkpoint),
  }
  const base = {
    output: result.output,
    messages: fromRuntimeMessages(result.messages),
    state,
    tokensUsed: result.tokensUsed,
    finishReason: result.finishReason,
  }
  switch (result.status) {
    case EXECUTION_OUTCOME_STATUSES.COMPLETED:
      return { ...base, status: EXECUTION_OUTCOME_STATUSES.COMPLETED }
    case EXECUTION_OUTCOME_STATUSES.SUSPENDED: {
      const interrupt = result.checkpoint.interrupt
      if (interrupt === undefined) {
        return {
          ...base,
          status: EXECUTION_OUTCOME_STATUSES.FAILED,
          error: new Error('暂停结果缺少 interrupt'),
        }
      }
      return {
        ...base,
        status: EXECUTION_OUTCOME_STATUSES.SUSPENDED,
        interrupt: {
          id: interrupt.toolCallId,
          toolName: interrupt.toolName,
          arguments: interrupt.arguments,
        },
      }
    }
    case EXECUTION_OUTCOME_STATUSES.CANCELLED:
      return { ...base, status: EXECUTION_OUTCOME_STATUSES.CANCELLED, reason: result.finishReason }
    case EXECUTION_OUTCOME_STATUSES.EXHAUSTED:
      return {
        ...base,
        status: EXECUTION_OUTCOME_STATUSES.EXHAUSTED,
        usage: { tokensUsed: result.tokensUsed },
      }
    case EXECUTION_OUTCOME_STATUSES.FAILED:
      return {
        ...base,
        status: EXECUTION_OUTCOME_STATUSES.FAILED,
        error: executionError ?? new Error(result.finishReason || 'Agent 执行失败'),
      }
  }
}
