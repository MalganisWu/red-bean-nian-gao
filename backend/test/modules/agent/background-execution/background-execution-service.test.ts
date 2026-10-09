import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LlmAdapter, LlmChunk, LlmRequest } from 'red-bean-qing-tuan/llm'
import type { RawMessage, ToolDispatcher, ToolSchema } from 'red-bean-qing-tuan/pipeline'

import { DefaultBackgroundAgentExecutionService } from '../../../../src/modules/agent/background-execution/service/default-background-agent-execution-service.js'
import type {
  AgentExecutionCommand,
  AgentExecutionOutcome,
  AgentExecutionPort,
} from '../../../../src/modules/agent/execution/port/agent-executor.js'
import type { AgentLoader } from '../../../../src/modules/agent/loader/port/agent-loader.port.js'
import type { MessageBuffer } from '../../../../src/modules/agent/session/message-buffer/port/message-buffer.port.js'
import type { MessageBufferGeneration } from '../../../../src/modules/agent/session/message-buffer/port/message-buffer.port.js'
import { runtimeState } from '../../../helpers/runtime-state.js'

const SIGNAL = new AbortController().signal

class NoopModel implements LlmAdapter {
  public streamCompletion(
    request: LlmRequest,
    signal: AbortSignal
  ): Promise<AsyncIterable<LlmChunk>> {
    signal.throwIfAborted()
    assert.ok(request.messages.length >= 0)
    return Promise.resolve(
      (async function* (): AsyncIterable<LlmChunk> {
        await Promise.resolve()
        yield { content: 'unused', finishReason: 'stop' }
      })()
    )
  }
}

class CapturingExecutor implements AgentExecutionPort {
  public command: AgentExecutionCommand | undefined

  public async execute(
    command: AgentExecutionCommand,
    signal: AbortSignal
  ): Promise<AgentExecutionOutcome> {
    signal.throwIfAborted()
    this.command = command
    command.eventSink?.publish({ type: 'reason', content: '检查', step: 1, timestamp: 1 })
    await command.messageObserver?.observe({ role: 'assistant', content: '完成' }, signal)
    return {
      status: 'completed',
      output: '完成',
      messages: [{ role: 'assistant', content: '完成' }],
      state: runtimeState([{ role: 'assistant', content: '完成' }]),
      tokensUsed: 1,
      finishReason: 'stop',
    }
  }
}

class MemoryBuffer implements MessageBuffer {
  public readonly appended: RawMessage[] = []
  public readonly cleared: string[] = []

  public append(_key: string, message: RawMessage, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.appended.push(message)
    return Promise.resolve()
  }

  public peek(_key: string, signal: AbortSignal): Promise<readonly RawMessage[]> {
    signal.throwIfAborted()
    return Promise.resolve([...this.appended])
  }

  public flush(_key: string, signal: AbortSignal): Promise<readonly RawMessage[]> {
    signal.throwIfAborted()
    return Promise.resolve(this.appended.splice(0))
  }

  public clear(key: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.cleared.push(key)
    return Promise.resolve()
  }

  public appendGeneration(
    key: string,
    _generation: MessageBufferGeneration,
    message: RawMessage,
    signal: AbortSignal
  ): Promise<void> {
    return this.append(key, message, signal)
  }

  public peekGeneration(
    key: string,
    _generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<readonly RawMessage[]> {
    return this.peek(key, signal)
  }

  public clearGeneration(
    key: string,
    _generation: MessageBufferGeneration,
    signal: AbortSignal
  ): Promise<void> {
    return this.clear(key, signal)
  }
}

void describe('DefaultBackgroundAgentExecutionService', () => {
  void it('在 Agent Module 内完成配置过滤、提示词合并和展示投影', async () => {
    const executor = new CapturingExecutor()
    const buffer = new MemoryBuffer()
    const service = new DefaultBackgroundAgentExecutionService(loader(), executor, buffer)

    const result = await service.execute(
      {
        agentId: 'default',
        sessionId: 'session-1',
        userId: 'user-1',
        runId: 'run-1',
        traceId: 'trace-1',
        recoveryKey: 'task-1',
        input: '提醒喝水',
        systemPromptAppendix: '后台任务规则',
        excludedToolNames: ['sys_ask_user'],
      },
      SIGNAL
    )

    assert.equal(executor.command?.definition.systemPrompt, '基础提示词\n\n后台任务规则')
    assert.deepEqual(
      executor.command?.definition.tools.map((tool): string => tool.function.name),
      ['sys_get_time']
    )
    assert.deepEqual(executor.command?.messages, [{ role: 'user', content: '提醒喝水' }])
    assert.equal(executor.command?.runId, 'run-1')
    assert.equal(executor.command?.sessionId, 'session-1')
    assert.equal(executor.command?.traceId, 'trace-1')
    assert.equal(result.displayMessages[0]?.content, '完成')
    assert.equal(buffer.appended[0]?.content, '完成')
  })

  void it('清理恢复数据时消费并删除对应缓冲', async () => {
    const buffer = new MemoryBuffer()
    const service = new DefaultBackgroundAgentExecutionService(
      loader(),
      new CapturingExecutor(),
      buffer
    )
    await buffer.append('task-1', { role: 'user', content: '待恢复' }, SIGNAL)

    await service.clearRecovery('task-1', SIGNAL)

    assert.deepEqual(buffer.appended, [])
    assert.deepEqual(buffer.cleared, ['task-1'])
  })
})

function loader(): AgentLoader {
  const tools: readonly ToolSchema[] = [schema('sys_get_time'), schema('sys_ask_user')]
  const dispatcher: ToolDispatcher = {
    dispatch: (): Promise<{ readonly content: string }> => Promise.resolve({ content: '' }),
  }
  return {
    load: () =>
      Promise.resolve({
        llmAdapter: new NoopModel(),
        toolDispatcher: dispatcher,
        tools,
        systemPrompt: '基础提示词',
      }),
  }
}

function schema(name: string): ToolSchema {
  return { type: 'function', function: { name, description: name, parameters: {} } }
}
