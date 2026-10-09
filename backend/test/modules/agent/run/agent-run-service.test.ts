import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LlmAdapter, LlmChunk } from 'red-bean-qing-tuan/llm'
import type { Span, SpanStart, Tracer } from 'red-bean-qing-tuan/observability'
import type { JsonValue } from 'red-bean-qing-tuan/pipeline'
import { MapToolDispatcher } from 'red-bean-qing-tuan/tools'

import type { AgentRunRequest } from '../../../../src/modules/agent/run/model/agent-run.js'
import {
  ProductAgentRunService,
  type AgentRunLogger,
} from '../../../../src/modules/agent/run/service/default-agent-run-service.js'
import type { ExecutableAgentConfig } from '../../../../src/modules/agent/run/service/agent-run-support.js'
import { RuntimeAgentExecutor } from '../../../../src/modules/agent/execution/adapter/runtime-agent-executor.js'
import type { AgentLoader } from '../../../../src/modules/agent/loader/port/agent-loader.port.js'
import { SessionLifecycle } from '../../../../src/modules/agent/session/run/service/default-session-run-service.js'
import {
  MemoryMessageBuffer,
  MemorySessionStore,
} from '../../../../src/modules/agent/session/repository/adapter/memory-session-repository.js'
import { runtimeMessages } from '../../../helpers/runtime-state.js'
import type { SessionRunServicePort } from '../../../../src/modules/agent/session/run/port/session-run-service.port.js'
import type {
  FinalizeSessionRunCommand,
  SessionRunRecord,
  StartSessionRunCommand,
} from '../../../../src/modules/agent/run-facts/model/session-run.js'
import { SESSION_RUN_STATUSES } from '../../../../src/modules/agent/run-facts/model/session-run.js'
import type { RunFact } from '../../../../src/modules/agent/run-facts/model/run-fact.js'
import type { RunFactRepository } from '../../../../src/modules/agent/run-facts/port/run-fact-repository.port.js'

const SIGNAL = new AbortController().signal

class RecordingRunFactRepository implements RunFactRepository {
  public created: StartSessionRunCommand[] = []
  public appended: Array<{ readonly runId: string; readonly fact: RunFact }> = []
  public finalized: Array<{ readonly runId: string; readonly command: FinalizeSessionRunCommand }> =
    []
  public failing = false

  public create(run: StartSessionRunCommand): Promise<SessionRunRecord> {
    if (this.failing) return Promise.reject(new Error('fact store down'))
    this.created.push(run)
    return Promise.resolve({
      ...run,
      runIndex: 0,
      status: SESSION_RUN_STATUSES.RUNNING,
      endedAt: null,
      facts: [],
      schemaVersion: 1,
    })
  }

  public async appendFact(runId: string, fact: RunFact): Promise<void> {
    // 人为让出事件循环，验证写入顺序由 recorder 串行化而不是巧合。
    await Promise.resolve()
    this.appended.push({ runId, fact })
  }

  public finalize(runId: string, command: FinalizeSessionRunCommand): Promise<void> {
    this.finalized.push({ runId, command })
    return Promise.resolve()
  }

  public listBySession(): Promise<readonly SessionRunRecord[]> {
    return Promise.resolve([])
  }
}

class OneReplyAdapter implements LlmAdapter {
  public streamCompletion(): Promise<AsyncIterable<LlmChunk>> {
    return Promise.resolve({
      async *[Symbol.asyncIterator](): AsyncGenerator<LlmChunk> {
        await Promise.resolve()
        yield { content: '完成', finishReason: 'stop' }
        yield {
          content: null,
          usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
        }
      },
    })
  }
}

class StaticLoader implements AgentLoader {
  public loads = 0

  public load(): Promise<ExecutableAgentConfig> {
    this.loads += 1
    return Promise.resolve({
      llmAdapter: new OneReplyAdapter(),
      toolDispatcher: new MapToolDispatcher([]),
      tools: [],
      systemPrompt: 'system',
      modelParams: {},
      runtimeConfig: {},
    })
  }
}

class FailingLoader implements AgentLoader {
  public load(): Promise<ExecutableAgentConfig> {
    return Promise.resolve({
      llmAdapter: {
        streamCompletion: (): Promise<AsyncIterable<LlmChunk>> =>
          Promise.reject(new Error('provider diagnostic')),
      },
      toolDispatcher: new MapToolDispatcher([]),
      tools: [],
      systemPrompt: 'system',
      modelParams: {},
      runtimeConfig: {},
    })
  }
}

class RoutedLoader implements AgentLoader {
  public load(): Promise<ExecutableAgentConfig> {
    return Promise.resolve({
      llmAdapter: new OneReplyAdapter(),
      toolDispatcher: new MapToolDispatcher([]),
      tools: [],
      systemPrompt: 'system',
      modelParams: { contextWindow: 131_072 },
      runtimeConfig: {},
      provider: 'openai',
      model: 'deepseek-chat',
    })
  }
}

/** 首个 token 后挂起直到运行信号中止，用于验证取消终态的事实归属。 */
class AbortingAdapter implements LlmAdapter {
  public streamCompletion(
    _request: unknown,
    signal: AbortSignal
  ): Promise<AsyncIterable<LlmChunk>> {
    return Promise.resolve({
      async *[Symbol.asyncIterator](): AsyncGenerator<LlmChunk> {
        yield { content: '一半' }
        await new Promise<void>((resolve): void => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', (): void => resolve(), { once: true })
        })
        throw new Error('operation aborted')
      },
    })
  }
}

class RecordingAgentRunLogger implements AgentRunLogger {
  public readonly records: Array<{
    readonly message: string
    readonly fields: Readonly<Record<string, unknown>> | undefined
  }> = []

  public error(message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.records.push({ message, fields })
  }
}

class RecordingTracer implements Tracer {
  public readonly names: string[] = []

  public start(start: SpanStart): Span {
    this.names.push(start.name)
    return {
      within<TValue>(operation: () => Promise<TValue>): Promise<TValue> {
        return operation()
      },
      setAttributes(): void {},
      end(): void {},
    }
  }
}

class BlockingFinalizationSessions implements SessionRunServicePort {
  public load(
    request: Parameters<SessionRunServicePort['load']>[0]
  ): Promise<Awaited<ReturnType<SessionRunServicePort['load']>>> {
    return Promise.resolve({
      ...request,
      checkpointRevision: 0n,
      fencingToken: 0n,
      runtimeState: undefined,
      recoveryMessages: [],
      displayMessages: [],
    })
  }

  public save(
    _state: Parameters<SessionRunServicePort['save']>[0],
    _outcome: Parameters<SessionRunServicePort['save']>[1],
    signal: AbortSignal
  ): Promise<void> {
    return new Promise<void>((_resolve, reject): void => {
      const rejectWithReason = (): void =>
        reject(signal.reason instanceof Error ? signal.reason : new Error('finalization timeout'))
      if (signal.aborted) rejectWithReason()
      else signal.addEventListener('abort', rejectWithReason, { once: true })
    })
  }
}

void describe('product Agent run service', () => {
  void it('runs one Runtime turn, emits one real done event, and persists display sections', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const loader = new StaticLoader()
    const service = new ProductAgentRunService({
      loader,
      executor: new RuntimeAgentExecutor(),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
    })

    const events = await collect(await service.start(request(), SIGNAL))

    assert.equal(loader.loads, 1)
    assert.deepEqual(events, [
      { type: 'status', code: 'thinking' },
      { type: 'token', content: '完成' },
      { type: 'done', tokensUsed: 7, sessionId: 'SESSION_1' },
    ])
    const saved = await sessions.getById('SESSION_1', 'USER_1', SIGNAL)
    assert.deepEqual(runtimeMessages(saved.runtimeState), [
      { role: 'user', content: '开始' },
      { role: 'assistant', content: '完成' },
    ])
    assert.equal(saved.displayMessages[0]?.role, 'user')
    assert.equal(saved.displayMessages[1]?.content, '完成')
    const sections = saved.displayMessages[1]?.sections
    assert.ok(Array.isArray(sections))
    assert.deepEqual(
      sections.map((section): JsonValue =>
        typeof section === 'object' && section !== null && !Array.isArray(section)
          ? (section['type'] ?? null)
          : null
      ),
      ['content']
    )
  })

  void it('persists the run container and message-level facts for a completed run', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const runFacts = new RecordingRunFactRepository()
    const service = new ProductAgentRunService({
      loader: new RoutedLoader(),
      executor: new RuntimeAgentExecutor(),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
      runFacts,
    })

    await collect(await service.start(request(), SIGNAL))

    assert.deepEqual(runFacts.created, [
      {
        runId: 'RUN_1',
        sessionId: 'SESSION_1',
        userId: 'USER_1',
        provider: 'openai',
        model: 'deepseek-chat',
        contextWindow: 131_072,
        startedAt: runFacts.created[0]?.startedAt ?? 0,
      },
    ])
    assert.deepEqual(
      runFacts.appended.map((entry): string => entry.fact.type),
      ['user', 'assistant']
    )
    const userFact = runFacts.appended[0]?.fact
    assert.ok(userFact?.type === 'user')
    assert.equal(userFact.content, '开始')
    const assistantFact = runFacts.appended[1]?.fact
    assert.ok(assistantFact?.type === 'assistant')
    assert.equal(assistantFact.content, '完成')
    assert.deepEqual(assistantFact.usage, {
      promptTokens: 3,
      completionTokens: 4,
      cacheReadTokens: null,
    })
    assert.equal(assistantFact.attempts.length, 1)
    assert.equal(runFacts.finalized.length, 1)
    assert.equal(runFacts.finalized[0]?.command.status, 'completed')
  })

  void it('attributes a user cancellation to the run terminal state', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const runFacts = new RecordingRunFactRepository()
    const service = new ProductAgentRunService({
      loader: {
        load: (): Promise<ExecutableAgentConfig> =>
          Promise.resolve({
            llmAdapter: new AbortingAdapter(),
            toolDispatcher: new MapToolDispatcher([]),
            tools: [],
            systemPrompt: 'system',
            modelParams: {},
            runtimeConfig: {},
            provider: 'openai',
            model: 'deepseek-chat',
          }),
      },
      executor: new RuntimeAgentExecutor(),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
      runFacts,
    })

    const controller = new AbortController()
    const handle = await service.start(request(), controller.signal)
    try {
      // 等首个 token 进入事实流后再取消，保证有未完成的步骤缓冲可补记。
      for await (const event of handle) {
        if (event.type === 'token') controller.abort()
      }
    } catch {
      // 取消路径以队列错误结束；事实断言在下方。
    }

    assert.equal(runFacts.finalized.length, 1)
    const command = runFacts.finalized[0]?.command
    assert.equal(command?.status, 'cancelled')
    assert.equal(command?.cancelledBy, 'user')
    assert.equal(typeof command?.cancelledAt, 'number')
    // 被取消时未结算的步骤缓冲按失败轮次纪律补记，不允许悄悄烂尾。
    const assistantFact = runFacts.appended.find(
      (entry): boolean => entry.fact.type === 'assistant'
    )?.fact
    assert.ok(assistantFact?.type === 'assistant')
    assert.equal(assistantFact.content, '一半')
    assert.equal(assistantFact.usage, null)
  })

  void it('keeps the chat healthy when the fact log is unavailable', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const logger = new RecordingAgentRunLogger()
    const runFacts = new RecordingRunFactRepository()
    runFacts.failing = true
    const service = new ProductAgentRunService({
      loader: new RoutedLoader(),
      executor: new RuntimeAgentExecutor(),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
      runFacts,
      logger,
    })

    const events = await collect(await service.start(request(), SIGNAL))

    assert.equal(events.at(-1)?.type, 'done')
    assert.deepEqual(runFacts.created, [])
    assert.deepEqual(runFacts.finalized, [])
    // 事实日志失败不影响会话主流程，但要留下一次服务端诊断。
    assert.equal(logger.records.length, 1)
    assert.match(logger.records[0]?.message ?? '', /事实日志/u)
  })

  void it('rejects an invalid answer before returning an SSE iterable', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const service = new ProductAgentRunService({
      loader: new StaticLoader(),
      executor: new RuntimeAgentExecutor(),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
    })

    await assert.rejects(
      service.start(
        {
          ...request(),
          messages: [],
          answer: { interactionId: 'missing', answers: {}, refused: false },
        },
        SIGNAL
      ),
      /不存在或已处理/u
    )
  })

  void it('drains scheduled delivery only after the completed conversation is saved', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const calls: string[] = []
    const service = new ProductAgentRunService({
      loader: new StaticLoader(),
      executor: new RuntimeAgentExecutor(),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
      deliveryQueue: {
        async drain(sessionId, signal): Promise<void> {
          signal.throwIfAborted()
          const saved = await sessions.getById(sessionId, 'USER_1', signal)
          assert.equal(saved.displayMessages.at(-1)?.content, '完成')
          calls.push(sessionId)
        },
      },
    })

    await collect(await service.start(request(), SIGNAL))

    assert.deepEqual(calls, ['SESSION_1'])
  })

  void it('does not fail a saved chat when deferred task delivery fails', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const service = new ProductAgentRunService({
      loader: new StaticLoader(),
      executor: new RuntimeAgentExecutor(),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
      deliveryQueue: {
        drain: (): Promise<void> => Promise.reject(new Error('redis unavailable')),
      },
    })

    const events = await collect(await service.start(request(), SIGNAL))

    assert.equal(events.at(-1)?.type, 'done')
    const saved = await sessions.getById('SESSION_1', 'USER_1', SIGNAL)
    assert.equal(saved.displayMessages.at(-1)?.content, '完成')
  })

  void it('wraps the Runtime pipeline in the configured product trace', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const tracer = new RecordingTracer()
    const service = new ProductAgentRunService({
      loader: new StaticLoader(),
      executor: new RuntimeAgentExecutor(tracer),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
    })

    await collect(await service.start(request(), SIGNAL))

    assert.deepEqual(tracer.names, ['agent.execute'])
  })

  void it('bounds Session finalization with an injectable timeout', async () => {
    const service = new ProductAgentRunService({
      loader: new StaticLoader(),
      executor: new RuntimeAgentExecutor(),
      sessions: new BlockingFinalizationSessions(),
      messageBuffer: new MemoryMessageBuffer(),
      finalizationTimeoutMilliseconds: 1,
    })

    const handle = await service.start(request(), SIGNAL)
    const result = await handle.completion

    assert.equal(result.status, 'failed')
    if (result.status === 'failed') assert.match(result.error.message, /timeout|aborted/iu)
  })

  void it('records complete server diagnostics with run, Session and Trace identity', async () => {
    const sessions = new MemorySessionStore()
    const buffer = new MemoryMessageBuffer()
    const logger = new RecordingAgentRunLogger()
    const service = new ProductAgentRunService({
      loader: new FailingLoader(),
      executor: new RuntimeAgentExecutor(),
      sessions: new SessionLifecycle(sessions, buffer),
      messageBuffer: buffer,
      logger,
    })

    const handle = await service.start(request(), SIGNAL)
    const result = await handle.completion

    assert.equal(result.status, 'failed')
    assert.equal(logger.records.length, 1)
    assert.equal(logger.records[0]?.message, 'agent run failed')
    assert.equal(logger.records[0]?.fields?.['run_id'], 'RUN_1')
    assert.equal(logger.records[0]?.fields?.['session_id'], 'SESSION_1')
    assert.equal(logger.records[0]?.fields?.['trace_id'], '0123456789abcdef0123456789abcdef')
    const error = logger.records[0]?.fields?.['error']
    assert.ok(error instanceof Error)
    assert.match(error.message, /provider diagnostic/u)
    assert.equal(typeof error.stack, 'string')
  })
})

function request(): AgentRunRequest {
  return {
    agentId: 'default',
    sessionId: 'SESSION_1',
    userId: 'USER_1',
    runId: 'RUN_1',
    traceId: '0123456789abcdef0123456789abcdef',
    messages: [{ role: 'user', content: '开始' }],
  }
}

async function collect<TValue>(values: AsyncIterable<TValue>): Promise<readonly TValue[]> {
  const collected: TValue[] = []
  for await (const value of values) collected.push(value)
  return collected
}
