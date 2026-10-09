import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { type RawMessage } from 'red-bean-qing-tuan/pipeline'
import { SubExecutionLifecycle } from '../../../../src/modules/agent/subagent/run/service/default-sub-execution-lifecycle.js'
import { SubExecutionRecovery } from '../../../../src/modules/agent/subagent/recovery/service/default-sub-execution-recovery.js'
import { runtimeMessages, runtimeState } from '../../../helpers/runtime-state.js'
import {
  SIGNAL,
  RUNTIME_STATE,
  MemorySubExecutionRepository,
  identity,
  pending,
  assistantToolCall,
  outcome,
} from './sub-execution-lifecycle-test-support.js'

void describe('sub execution lifecycle', () => {
  void it('classifies only a dangling sys_ask_user call as awaiting_user', async () => {
    const repository = new MemorySubExecutionRepository()
    const awaitingId = 'SAEX_awaiting'
    const interruptedId = 'SAEX_interrupted'
    const answeredId = 'SAEX_answered'
    await repository.create(pending(awaitingId), SIGNAL)
    await repository.create(pending(interruptedId), SIGNAL)
    await repository.create(pending(answeredId), SIGNAL)
    await repository.appendRecoveryMessage(
      awaitingId,
      0n,
      assistantToolCall('call_ask', 'sys_ask_user'),
      SIGNAL
    )
    await repository.appendRecoveryMessage(
      interruptedId,
      0n,
      assistantToolCall('call_fetch', 'sys_fetch_url'),
      SIGNAL
    )
    await repository.appendRecoveryMessage(
      answeredId,
      0n,
      assistantToolCall('call_answered', 'sys_ask_user'),
      SIGNAL
    )
    await repository.appendRecoveryMessage(
      answeredId,
      0n,
      { role: 'tool', content: '{"answers":{"q1":"继续"}}', toolCallId: 'call_answered' },
      SIGNAL
    )

    await new SubExecutionRecovery(repository, RUNTIME_STATE).prepare('session-1', SIGNAL)

    const awaiting = await repository.getById(awaitingId, SIGNAL)
    const interrupted = await repository.getById(interruptedId, SIGNAL)
    const answered = await repository.getById(answeredId, SIGNAL)
    assert.equal(awaiting?.status, 'awaiting_user')
    assert.equal(runtimeMessages(awaiting?.runtimeState).length, 1)
    assert.equal(interrupted?.status, 'interrupted')
    assert.equal(runtimeMessages(interrupted?.runtimeState).length, 2)
    assert.equal(runtimeMessages(interrupted?.runtimeState).at(-1)?.role, 'tool')
    assert.equal(answered?.status, 'interrupted')
    assert.equal(runtimeMessages(answered?.runtimeState).length, 2)
    assert.deepEqual(awaiting?.recoveryMessages, [])
    assert.deepEqual(interrupted?.recoveryMessages, [])
    assert.equal(awaiting?.pendingInterruptId, 'call_ask')
  })

  void it('claims after the pending snapshot and recovers every confirmed old-owner write', async () => {
    const repository = new MemorySubExecutionRepository()
    const executionId = 'SAEX_pending_claim_race'
    await repository.create(pending(executionId), SIGNAL)
    await repository.appendRecoveryMessage(
      executionId,
      0n,
      { role: 'user', content: '快照前消息' },
      SIGNAL
    )
    repository.afterListPending = async (): Promise<void> => {
      repository.afterListPending = undefined
      await repository.appendRecoveryMessage(
        executionId,
        0n,
        { role: 'assistant', content: '快照后、认领前消息' },
        SIGNAL
      )
    }

    await new SubExecutionRecovery(repository, RUNTIME_STATE).prepare('session-1', SIGNAL)

    const recovered = await repository.getById(executionId, SIGNAL)
    assert.deepEqual(runtimeMessages(recovered?.runtimeState), [
      { role: 'user', content: '快照前消息' },
      { role: 'assistant', content: '快照后、认领前消息' },
    ])
    assert.equal(recovered?.revision, 2n)
    await assert.rejects(
      repository.appendRecoveryMessage(
        executionId,
        0n,
        { role: 'assistant', content: '认领后旧 owner 迟到消息' },
        SIGNAL
      ),
      /owner conflict/u
    )
  })

  void it('recovers a crash, preserves an authorized resume interrupt, and clears it only after save', async () => {
    const repository = new MemorySubExecutionRepository()
    const executionId = 'SAEX_recover_resume'
    await repository.create(pending(executionId), SIGNAL)
    await repository.appendRecoveryMessage(
      executionId,
      0n,
      { role: 'user', content: '分析这份 PDF' },
      SIGNAL
    )
    await repository.appendRecoveryMessage(
      executionId,
      0n,
      assistantToolCall('call_fetch', 'sys_fetch_url'),
      SIGNAL
    )
    await new SubExecutionRecovery(repository, RUNTIME_STATE).prepare('session-1', SIGNAL)

    const interruptId = 'call_ask'
    const interrupted = await repository.getById(executionId, SIGNAL)
    assert.ok(interrupted !== undefined)
    interrupted.status = 'awaiting_user'
    interrupted.pendingInterruptId = interruptId
    interrupted.runtimeState = runtimeState([
      ...runtimeMessages(interrupted.runtimeState),
      assistantToolCall(interruptId, 'sys_ask_user'),
    ])
    await repository.update(interrupted, SIGNAL)
    const lifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '测试子 Agent',
    })
    await assert.rejects(
      lifecycle.load(
        identity({
          executionId,
          sessionId: 'other-session',
          userId: 'other-user',
        }),
        true,
        SIGNAL
      ),
      /不属于当前会话/u
    )
    assert.deepEqual((await repository.getById(executionId, SIGNAL))?.recoveryMessages, [])

    const resumed = identity({
      executionId,
      interruptId,
    })
    const loaded = await lifecycle.load(resumed, true, SIGNAL)
    assert.equal(runtimeMessages(loaded.state).length, 4)
    assert.equal(runtimeMessages(loaded.state).at(-1)?.toolCalls?.[0]?.id, interruptId)

    const answer: RawMessage = {
      role: 'tool',
      content: '{"answers":{"q1":"继续"}}',
      toolCallId: interruptId,
    }
    const messages = [...runtimeMessages(loaded.state), ...loaded.recoveryMessages, answer]
    await lifecycle.save(
      resumed,
      outcome(messages),
      undefined,
      undefined,
      loaded.persistenceRevision,
      loaded.lease,
      SIGNAL
    )
    assert.deepEqual((await repository.getById(executionId, SIGNAL))?.recoveryMessages, [])
    assert.equal((await repository.getById(executionId, SIGNAL))?.status, 'completed')
  })

  void it('writes outcome statistics and the final result summary', async () => {
    const repository = new MemorySubExecutionRepository()
    const createdAt = new Date(Date.now() - 2_000)
    const executionId = 'SAEX_save_stats'
    await repository.create(pending(executionId, createdAt), SIGNAL)
    const lifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '汇率助手',
      modelName: 'deepseek-v4-pro',
      systemPrompt: '你是汇率助手',
    })
    const run = identity({
      executionId,
      messages: [{ role: 'user', content: '查一下汇率' }],
    })

    await lifecycle.save(
      run,
      outcome(
        [
          { role: 'user', content: '查一下汇率' },
          { role: 'assistant', content: 'USD/CNY 7.15' },
        ],
        321
      ),
      undefined,
      undefined,
      0n,
      undefined,
      SIGNAL
    )
    const saved = await repository.getById(executionId, SIGNAL)
    assert.equal(saved?.status, 'completed')
    assert.equal(saved?.tokensUsed, 321)
    assert.equal(saved?.modelName, 'deepseek-v4-pro')
    assert.equal(saved?.systemPrompt, '你是汇率助手')
    assert.ok((saved?.elapsedMilliseconds ?? 0) >= 1_000)
    assert.equal(saved?.resultSummary, 'USD/CNY 7.15')
  })

  void it('allows only one concurrent resume claimant', async () => {
    const repository = new MemorySubExecutionRepository()
    const executionId = 'SAEX_double_resume'
    const record = pending(executionId)
    record.status = 'awaiting_user'
    record.pendingInterruptId = 'call_ask'
    record.runtimeState = runtimeState([assistantToolCall('call_ask', 'sys_ask_user')])
    await repository.create(record, SIGNAL)
    const lifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '测试子 Agent',
    })
    const resumed = identity({ executionId, interruptId: 'call_ask' })

    const attempts = await Promise.allSettled([
      lifecycle.load(resumed, true, SIGNAL),
      lifecycle.load(resumed, true, SIGNAL),
    ])

    assert.equal(attempts.filter((attempt): boolean => attempt.status === 'fulfilled').length, 1)
    assert.equal(attempts.filter((attempt): boolean => attempt.status === 'rejected').length, 1)
    assert.equal((await repository.getById(executionId, SIGNAL))?.status, 'running')
  })

  void it('rejects an invalid interrupt before changing status or revision', async () => {
    const repository = new MemorySubExecutionRepository()
    const executionId = 'SAEX_wrong_interrupt'
    const record = pending(executionId)
    record.status = 'awaiting_user'
    record.pendingInterruptId = 'call_expected'
    record.runtimeState = runtimeState([assistantToolCall('call_expected', 'sys_ask_user')])
    await repository.create(record, SIGNAL)
    const lifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '测试子 Agent',
    })

    await assert.rejects(
      lifecycle.load(identity({ executionId, interruptId: 'call_stale' }), true, SIGNAL),
      /interrupt ID 无效或已过期/u
    )

    const unchanged = await repository.getById(executionId, SIGNAL)
    assert.equal(unchanged?.status, 'awaiting_user')
    assert.equal(unchanged?.revision, 0n)
    assert.equal(unchanged?.pendingInterruptId, 'call_expected')
  })
})
