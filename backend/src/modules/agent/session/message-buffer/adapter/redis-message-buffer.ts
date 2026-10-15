import { z } from 'zod'

import type { AgentMessage, AgentToolCall } from '../../../model/agent-message.js'
import { serializeAgentMessage } from '../../../serialization/agent-message-serializer.js'
import type { MessageBuffer, MessageBufferGeneration } from '../port/message-buffer.port.js'
import { optionalField } from '../../../../../shared/object/optional-field.js'

/**
 * 恢复缓冲的默认存活时长（秒），24 小时。
 * 缓冲只是「运行中断后还能续上」的短期增量，过期即弃，不必长期保留；
 * 取一天是为了盖过用户隔夜回来继续同一会话的常见间隔。
 */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60
/** 单条 tool_call 的宽松结构校验；只保证能安全映射回领域模型，不做业务校验。 */
const toolCallSchema = z.object({
  index: z.number().int().optional(),
  id: z.string(),
  type: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
})
/**
 * 单条 Redis 消息的宽松结构；字段用下划线命名对齐序列化后的键名，
 * 用可选字段容纳不同角色消息的形状差异，真正的领域形状由 `decodeMessage` 收口。
 */
const rawMessageSchema = z.object({
  role: z.string(),
  content: z.string().nullable(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
})

/** 消息缓冲实际用到的 Redis 能力子集；只声明这两个方法，避免把整个连接暴露给缓冲实现。 */
export interface RedisMessageBufferStore {
  /**
   * 向列表尾部追加一个值，并刷新整键的过期时间；写入与设 TTL 需原子完成。
   *
   * @param key - 目标列表键。
   * @param value - 待追加的序列化字符串。
   * @param ttlSeconds - 追加后整键的存活秒数。
   * @param signal - 取消信号；取消后放弃写入。
   */
  appendListWithExpiry(
    key: string,
    value: string,
    ttlSeconds: number,
    signal: AbortSignal
  ): Promise<void>
  /**
   * 守卫式追加：仅当 `guardKey` 的值等于 `expectedValue` 时才追加，用于拒绝已失租 owner 的写入。
   *
   * @param guardKey - 守卫键，通常是会话锁键。
   * @param expectedValue - 守卫键应持有的值，通常是本轮的 writeProof。
   * @param key - 目标列表键。
   * @param value - 待追加的序列化字符串。
   * @param ttlSeconds - 追加后整键的存活秒数。
   * @param signal - 取消信号；取消后放弃写入。
   * @returns 守卫成立并写入成功时为 true；守卫不符时不做写入并返回 false。
   */
  appendListWithExpiryIfValue(
    guardKey: string,
    expectedValue: string,
    key: string,
    value: string,
    ttlSeconds: number,
    signal: AbortSignal
  ): Promise<boolean>
  /**
   * 读取列表全量但不删除。
   *
   * @param key - 目标列表键。
   * @param signal - 取消信号；取消后放弃读取。
   * @returns 列表内的序列化字符串；键不存在时为空数组。
   */
  listRange(key: string, signal: AbortSignal): Promise<readonly string[]>
  /**
   * 取出列表全量并删除键；具有消费语义。
   *
   * @param key - 目标列表键。
   * @param signal - 取消信号；取消后放弃本次消费。
   * @returns 本次取出的序列化字符串；键不存在时为空数组。
   */
  consumeList(key: string, signal: AbortSignal): Promise<readonly string[]>
  /**
   * 删除键；键不存在时幂等成功。
   *
   * @param key - 目标键。
   * @param signal - 取消信号；取消后放弃删除。
   */
  delete(key: string, signal: AbortSignal): Promise<void>
  /**
   * 守卫式删除：仅当 `guardKey` 的值等于 `expectedValue` 时才删除，避免误删他人内容。
   *
   * @param guardKey - 守卫键，通常是会话锁键。
   * @param expectedValue - 守卫键应持有的值，通常是本轮的 writeProof。
   * @param key - 目标键。
   * @param signal - 取消信号；取消后放弃删除。
   * @returns 守卫成立并删除成功时为 true；守卫不符时不做删除并返回 false。
   */
  deleteIfValue(
    guardKey: string,
    expectedValue: string,
    key: string,
    signal: AbortSignal
  ): Promise<boolean>
}

/** 与既有 `agent:cache:*:buffer` 键布局兼容的 Redis 恢复缓冲区。 */
export class RedisMessageBuffer implements MessageBuffer {
  /** 注入的 Redis 能力子集；缓冲只走这里声明的几个方法。 */
  readonly #redis: RedisMessageBufferStore
  /** 每次写入为缓冲键设定的存活秒数，构造时经校验固定。 */
  readonly #ttlSeconds: number

  public constructor(redis: RedisMessageBufferStore, ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError('消息缓冲 TTL 必须是正整数')
    }
    this.#redis = redis
    this.#ttlSeconds = ttlSeconds
  }

  /**
   * 追加一条消息到会话的恢复缓冲；写入失败包装成带会话标识的中文错误，便于定位。
   *
   * @param sessionId - 目标会话标识，决定缓冲键。
   * @param message - 待缓冲的 Agent 消息，先序列化再写入，形状由序列化器保证。
   * @param signal - 取消信号，透传到 Redis 写入，取消时中止而非落半条。
   */
  public async append(
    sessionId: string,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await this.#redis.appendListWithExpiry(
        bufferKey(sessionId),
        JSON.stringify(serializeAgentMessage(message)),
        this.#ttlSeconds,
        signal
      )
    } catch (cause: unknown) {
      throw contextualError(`写入消息缓冲失败 session=${sessionId}`, cause)
    }
  }

  /**
   * 只读窥视缓冲内容，不清除；用于恢复前判断有没有可恢复的增量。
   *
   * @param sessionId - 目标会话标识，决定缓冲键。
   * @param signal - 取消信号，透传到 Redis 读取。
   * @returns 反序列化并逐条校验后的消息；脏数据会抛错而不是被带进上下文。
   */
  public async peek(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    try {
      return decodeMessages(await this.#redis.listRange(bufferKey(sessionId), signal))
    } catch (cause: unknown) {
      throw contextualError(`读取消息缓冲失败 session=${sessionId}`, cause)
    }
  }

  /**
   * 取出并清空缓冲（消费语义）；内容已随取出动作从 Redis 删除，重复调用只会拿到空数组。
   *
   * @param sessionId - 目标会话标识，决定缓冲键。
   * @param signal - 取消信号，透传到 Redis 读取。
   * @returns 本次消费掉的消息；反序列化失败时抛错，失败前不会移除键。
   */
  public async flush(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    try {
      return decodeMessages(await this.#redis.consumeList(bufferKey(sessionId), signal))
    } catch (cause: unknown) {
      throw contextualError(`读取消息缓冲失败 session=${sessionId}`, cause)
    }
  }

  /**
   * 丢弃整个缓冲；幂等，键不存在时同样成功。
   *
   * @param sessionId - 目标会话标识，决定缓冲键。
   * @param signal - 取消信号，透传到 Redis 删除。
   */
  public async clear(sessionId: string, signal: AbortSignal): Promise<void> {
    try {
      await this.#redis.delete(bufferKey(sessionId), signal)
    } catch (cause: unknown) {
      throw contextualError(`清空消息缓冲失败 session=${sessionId}`, cause)
    }
  }

  /**
   * 写入「分代」缓冲：键里带 revision，因此每次运行各写各的，不会与上一代混在一起。
   *
   * 带 `writeProof` 时走守卫写入——先核对 `session_lock:<id>` 的值仍是本持有者，
   * 不符就抛「session lease owner 已失效」。这道守卫的必要性在于：
   * 写缓冲的是**正持有会话锁的那次运行**，锁被接管说明这次运行已经过期，
   * 它刚刚产生的消息属于一个不会再被采纳的分支，写进去只会污染下一代的恢复内容。
   *
   * @param sessionId - 目标会话标识，与 generation 一起决定分代键。
   * @param generation - 本次运行的分代（revision + 可选 writeProof）；带 writeProof 时写入受锁所有权守卫。
   * @param message - 待缓冲的 Agent 消息，序列化后写入。
   * @param signal - 取消信号，透传到 Redis 写入。
   */
  public async appendGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    message: AgentMessage,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const value = JSON.stringify(serializeAgentMessage(message))
      if (generation.writeProof === undefined) {
        await this.#redis.appendListWithExpiry(
          generationKey(sessionId, generation),
          value,
          this.#ttlSeconds,
          signal
        )
      } else {
        const written = await this.#redis.appendListWithExpiryIfValue(
          `session_lock:${sessionId}`,
          generation.writeProof,
          generationKey(sessionId, generation),
          value,
          this.#ttlSeconds,
          signal
        )
        if (!written) throw new Error('session lease owner 已失效')
      }
    } catch (cause: unknown) {
      throw contextualError(`写入分代消息缓冲失败 session=${sessionId}`, cause)
    }
  }

  /**
   * 只读窥视某一代的缓冲内容，不清除；恢复路径据此判断该代有没有未提交的增量。
   *
   * @param sessionId - 目标会话标识，与 generation 一起决定分代键。
   * @param generation - 目标分代；读的是这一代专属的键，不会串到上一代。
   * @param signal - 取消信号，透传到 Redis 读取。
   * @returns 该代反序列化并校验后的消息；脏数据抛错而非带入上下文。
   */
  public async peekGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<readonly AgentMessage[]> {
    try {
      return decodeMessages(
        await this.#redis.listRange(generationKey(sessionId, generation), signal)
      )
    } catch (cause: unknown) {
      throw contextualError(`读取分代消息缓冲失败 session=${sessionId}`, cause)
    }
  }

  /**
   * 清除某一代缓冲；成功保存后才调用，键不存在时幂等成功。
   *
   * 带 `writeProof` 时走守卫删除：仅当 `session_lock:<id>` 的值仍是本持有者才删，
   * 否则抛「session lease owner 已失效」——此时锁已易主，删的可能是别人的恢复内容。
   *
   * @param sessionId - 目标会话标识，与 generation 一起决定分代键。
   * @param generation - 目标分代；只有它对应的键会被删除。
   * @param signal - 取消信号，透传到 Redis 删除。
   */
  public async clearGeneration(
    sessionId: string,
    generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<void> {
    try {
      if (generation.writeProof === undefined) {
        await this.#redis.delete(generationKey(sessionId, generation), signal)
      } else {
        const deleted = await this.#redis.deleteIfValue(
          `session_lock:${sessionId}`,
          generation.writeProof,
          generationKey(sessionId, generation),
          signal
        )
        if (!deleted) throw new Error('session lease owner 已失效')
      }
    } catch (cause: unknown) {
      throw contextualError(`清空分代消息缓冲失败 session=${sessionId}`, cause)
    }
  }
}

/**
 * 拼装会话的恢复缓冲键；沿用既有 `agent:cache:*:buffer` 布局，保证与旧数据兼容。
 *
 * @param sessionId - 目标会话标识。
 * @returns 该会话的缓冲键。
 */
function bufferKey(sessionId: string): string {
  return `agent:cache:${sessionId}:buffer`
}

/**
 * 在缓冲键上追加分代 revision，得到这一次运行专属的键；各代因此互不覆盖。
 *
 * @param sessionId - 目标会话标识。
 * @param generation - 本次运行的分代，只用其 `revision` 参与拼键。
 * @returns 该会话该代的缓冲键。
 */
function generationKey(sessionId: string, generation: MessageBufferGeneration): string {
  return `${bufferKey(sessionId)}:${generation.revision.toString()}`
}

/**
 * 反序列化并逐条校验。Redis 里存放的内容不可信（可能是旧版本写入的、或被人手工改过），
 * 因此每条都过一遍 Zod，形状不对就抛错而不是把脏数据带进上下文。
 * 缺失的可选字段用 `optionalField` 处理，保证「缺席」与「显式 undefined」在结果里是同一种表示。
 *
 * @param values - Redis 返回的原始字符串列表。
 * @returns 逐条校验通过后的消息；任一条不合法即抛错，不做部分返回。
 */
function decodeMessages(values: readonly string[]): readonly AgentMessage[] {
  return values.map((value): AgentMessage => decodeMessage(value))
}

/**
 * 反序列化单条消息并逐字段校验；任一步失败都以同一条中文错误抛出。
 *
 * @param value - 单条消息的原始字符串。
 * @returns 校验通过并映射回领域的消息。
 */
function decodeMessage(value: string): AgentMessage {
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(value)
  } catch (cause: unknown) {
    throw new Error('反序列化消息失败', { cause })
  }
  const parsed = rawMessageSchema.safeParse(parsedJson)
  if (!parsed.success) throw new Error('反序列化消息失败', { cause: parsed.error })
  const toolCalls: readonly AgentToolCall[] | undefined = parsed.data.tool_calls?.map(
    (call): AgentToolCall => ({
      ...optionalField('index', call.index),
      id: call.id,
      type: call.type,
      function: call.function,
    })
  )
  return {
    role: parsed.data.role,
    content: parsed.data.content,
    ...optionalField('toolCalls', toolCalls),
    ...optionalField('toolCallId', parsed.data.tool_call_id),
    ...optionalField('name', parsed.data.name),
  }
}

/**
 * 给底层失败补上中文上下文再抛出，并保留 cause 链——
 * 只取 message 重抛会让日志与观测断链，原始错误必须留在 cause 里。
 *
 * @param context - 中文上下文前缀，说明这次操作在做什么。
 * @param cause - 被包装的原始错误，可能是任意抛出物。
 * @returns 带上下文与 cause 的错误。
 */
function contextualError(context: string, cause: unknown): Error {
  return new Error(`${context}：${cause instanceof Error ? cause.message : String(cause)}`, {
    cause,
  })
}
