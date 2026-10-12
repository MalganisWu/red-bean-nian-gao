import { z } from 'zod'

import type { AgentMessage, AgentToolCall } from '../../../model/agent-message.js'
import { serializeAgentMessage } from '../../../serialization/agent-message-serializer.js'
import type { MessageBuffer, MessageBufferGeneration } from '../port/message-buffer.port.js'
import { optionalField } from '../../../../../shared/object/optional-field.js'

const DEFAULT_TTL_SECONDS = 24 * 60 * 60
const toolCallSchema = z.object({
  index: z.number().int().optional(),
  id: z.string(),
  type: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
})
const rawMessageSchema = z.object({
  role: z.string(),
  content: z.string().nullable(),
  tool_calls: z.array(toolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
})

/** 消息缓冲实际用到的 Redis 能力子集；只声明这两个方法，避免把整个连接暴露给缓冲实现。 */
export interface RedisMessageBufferStore {
  appendListWithExpiry(
    key: string,
    value: string,
    ttlSeconds: number,
    signal: AbortSignal
  ): Promise<void>
  appendListWithExpiryIfValue(
    guardKey: string,
    expectedValue: string,
    key: string,
    value: string,
    ttlSeconds: number,
    signal: AbortSignal
  ): Promise<boolean>
  listRange(key: string, signal: AbortSignal): Promise<readonly string[]>
  consumeList(key: string, signal: AbortSignal): Promise<readonly string[]>
  delete(key: string, signal: AbortSignal): Promise<void>
  deleteIfValue(
    guardKey: string,
    expectedValue: string,
    key: string,
    signal: AbortSignal
  ): Promise<boolean>
}

/** 与既有 `agent:cache:*:buffer` 键布局兼容的 Redis 恢复缓冲区。 */
export class RedisMessageBuffer implements MessageBuffer {
  readonly #redis: RedisMessageBufferStore
  readonly #ttlSeconds: number

  public constructor(redis: RedisMessageBufferStore, ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError('message buffer TTL must be a positive integer')
    }
    this.#redis = redis
    this.#ttlSeconds = ttlSeconds
  }

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

  public async peek(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    try {
      return decodeMessages(await this.#redis.listRange(bufferKey(sessionId), signal))
    } catch (cause: unknown) {
      throw contextualError(`读取消息缓冲失败 session=${sessionId}`, cause)
    }
  }

  public async flush(sessionId: string, signal: AbortSignal): Promise<readonly AgentMessage[]> {
    try {
      return decodeMessages(await this.#redis.consumeList(bufferKey(sessionId), signal))
    } catch (cause: unknown) {
      throw contextualError(`读取消息缓冲失败 session=${sessionId}`, cause)
    }
  }

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

function bufferKey(sessionId: string): string {
  return `agent:cache:${sessionId}:buffer`
}

function generationKey(sessionId: string, generation: MessageBufferGeneration): string {
  return `${bufferKey(sessionId)}:${generation.revision.toString()}`
}

/**
 * 反序列化并逐条校验。Redis 里存放的内容不可信（可能是旧版本写入的、或被人手工改过），
 * 因此每条都过一遍 Zod，形状不对就抛错而不是把脏数据带进上下文。
 * 缺失的可选字段用 `optionalField` 处理，保证「缺席」与「显式 undefined」在结果里是同一种表示。
 */
function decodeMessages(values: readonly string[]): readonly AgentMessage[] {
  return values.map((value): AgentMessage => {
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
  })
}

function contextualError(context: string, cause: unknown): Error {
  return new Error(`${context}: ${cause instanceof Error ? cause.message : String(cause)}`, {
    cause,
  })
}
