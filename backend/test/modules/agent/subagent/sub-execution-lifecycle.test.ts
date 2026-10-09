import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SubExecutionLifecycle } from '../../../../src/modules/agent/subagent/run/service/default-sub-execution-lifecycle.js'
import { buildSubExecutionDisplay } from '../../../../src/modules/agent/subagent/run/service/sub-execution-result.js'
import { runtimeState } from '../../../helpers/runtime-state.js'
import {
  SIGNAL,
  MemorySubExecutionRepository,
  identity,
  pending,
  assistantToolCall,
  outcome,
} from './sub-execution-lifecycle-test-support.js'

void describe('sub execution lifecycle', () => {
  void it('reclaims an expired running resume with a new revision fence', async () => {
    const repository = new MemorySubExecutionRepository()
    const executionId = 'SAEX_expired_resume'
    const record = pending(executionId)
    record.status = 'running'
    record.pendingInterruptId = 'call_ask'
    record.runtimeState = runtimeState([{ role: 'user', content: '恢复我' }])
    await repository.create(record, SIGNAL)
    const lifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '测试子 Agent',
      now: (): Date => new Date('2026-09-04T01:00:00.000Z'),
    })

    const loaded = await lifecycle.load(
      identity({ executionId, interruptId: 'call_ask' }),
      true,
      SIGNAL
    )

    assert.equal(loaded.persistenceRevision, 1n)
    assert.equal((await repository.getById(executionId, SIGNAL))?.status, 'running')
  })

  void it('fences an expired owner and isolates both owners message buffers', async () => {
    const repository = new MemorySubExecutionRepository()
    const executionId = 'SAEX_reclaim_race'
    const record = pending(executionId)
    record.status = 'awaiting_user'
    record.pendingInterruptId = 'call_ask'
    record.runtimeState = runtimeState([assistantToolCall('call_ask', 'sys_ask_user')])
    await repository.create(record, SIGNAL)
    const oldLifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '测试子 Agent',
      now: (): Date => new Date('2026-09-04T00:00:00.000Z'),
      resumeLeaseMilliseconds: 50,
      resumeHeartbeatMilliseconds: 5,
    })
    const resumed = identity({ executionId, interruptId: 'call_ask' })
    const oldOwner = await oldLifecycle.load(resumed, true, SIGNAL)
    await repository.appendRecoveryMessage(
      executionId,
      oldOwner.persistenceRevision ?? -1n,
      { role: 'assistant', content: '旧 owner 部分输出' },
      SIGNAL
    )
    const newLifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '测试子 Agent',
      now: (): Date => new Date('2026-09-04T01:00:00.000Z'),
    })

    const newOwner = await newLifecycle.load(resumed, true, SIGNAL)
    await new Promise((resolve): void => {
      setTimeout(resolve, 20)
    })
    assert.equal(oldOwner.lease?.signal.aborted, true)
    await assert.rejects(
      repository.appendRecoveryMessage(
        executionId,
        oldOwner.persistenceRevision ?? -1n,
        { role: 'assistant', content: '旧 owner 迟到输出' },
        SIGNAL
      ),
      /owner conflict/u
    )
    await repository.appendRecoveryMessage(
      executionId,
      newOwner.persistenceRevision ?? -1n,
      { role: 'assistant', content: '新 owner 输出' },
      SIGNAL
    )
    const thirdLifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '测试子 Agent',
      now: (): Date => new Date('2026-09-04T02:00:00.000Z'),
    })
    const thirdOwner = await thirdLifecycle.load(resumed, true, SIGNAL)
    assert.deepEqual(thirdOwner.recoveryMessages, [
      { role: 'assistant', content: '旧 owner 部分输出' },
      { role: 'assistant', content: '新 owner 输出' },
    ])
    await assert.rejects(
      repository.appendRecoveryMessage(
        executionId,
        newOwner.persistenceRevision ?? -1n,
        { role: 'assistant', content: '新 owner 迟到输出' },
        SIGNAL
      ),
      /owner conflict/u
    )

    await assert.rejects(
      oldLifecycle.save(
        resumed,
        outcome([{ role: 'assistant', content: '旧 owner 结果' }]),
        undefined,
        undefined,
        oldOwner.persistenceRevision,
        oldOwner.lease,
        SIGNAL
      ),
      /lease 已失效|revision 冲突/u
    )
    await thirdLifecycle.save(
      resumed,
      outcome([...thirdOwner.recoveryMessages, { role: 'assistant', content: '最终 owner 结果' }]),
      undefined,
      undefined,
      thirdOwner.persistenceRevision,
      thirdOwner.lease,
      SIGNAL
    )

    assert.equal((await repository.getById(executionId, SIGNAL))?.resultSummary, '最终 owner 结果')
    assert.deepEqual((await repository.getById(executionId, SIGNAL))?.recoveryMessages, [])
  })

  void it('rejects stale CAS writes and does not clear buffered messages', async () => {
    const repository = new MemorySubExecutionRepository()
    const executionId = 'SAEX_stale_save'
    const record = pending(executionId)
    record.status = 'interrupted'
    record.pendingInterruptId = 'call_resume'
    record.runtimeState = runtimeState([{ role: 'user', content: '继续' }])
    await repository.create(record, SIGNAL)
    const lifecycle = new SubExecutionLifecycle(repository, {
      agentId: 'agent-1',
      agentName: '测试子 Agent',
    })
    const resumed = identity({ executionId, interruptId: 'call_resume' })
    const loaded = await lifecycle.load(resumed, true, SIGNAL)
    await repository.appendRecoveryMessage(
      executionId,
      loaded.persistenceRevision ?? -1n,
      { role: 'assistant', content: '未提交结果' },
      SIGNAL
    )
    const concurrent = await repository.getById(executionId, SIGNAL)
    assert.ok(concurrent !== undefined)
    concurrent.resultSummary = '并发写入'
    await repository.update(concurrent, SIGNAL)

    await assert.rejects(
      lifecycle.save(
        resumed,
        outcome([{ role: 'assistant', content: '旧执行结果' }]),
        undefined,
        undefined,
        loaded.persistenceRevision,
        loaded.lease,
        SIGNAL
      ),
      /revision 冲突/u
    )
    assert.deepEqual((await repository.getById(executionId, SIGNAL))?.recoveryMessages, [
      { role: 'assistant', content: '未提交结果' },
    ])
  })

  void it('builds display hand-off with execution status and summary', () => {
    const display = buildSubExecutionDisplay({
      agentId: 'agent-1',
      agentName: '汇率助手',
      executionId: 'SAEX_display',
      parentCallId: 'call_parent',
      sections: [{ type: 'content', content: '子 agent 输出' }],
      status: 'completed',
      resultSummary: 'USD/CNY 7.15',
    })
    assert.equal(display['status'], 'completed')
    assert.equal(display['result_summary'], 'USD/CNY 7.15')
    assert.equal(display['parent_call_id'], 'call_parent')
    assert.deepEqual(display['sections'], [{ type: 'content', content: '子 agent 输出' }])
  })

  void it('round-trips an actual sub execution repository when integration PostgreSQL is configured', async (test) => {
    const databaseUrl = process.env['RBNG_INTEGRATION_DATABASE_URL']
    if (databaseUrl === undefined || databaseUrl.trim() === '') {
      if (process.env['RBNG_INTEGRATION_REQUIRED'] === '1') {
        throw new Error('RBNG_INTEGRATION_DATABASE_URL 未设置')
      }
      test.skip('RBNG_INTEGRATION_DATABASE_URL 未设置，跳过 sub execution PostgreSQL 集成测试')
      return
    }
    const { connectPostgres } = await import('../../../../src/infra/database/postgres.js')
    const { PostgresSubExecutionRepository } =
      await import('../../../../src/modules/agent/subagent/repository/adapter/postgres-sub-execution-repository.js')
    const database = await connectPostgres(databaseUrl, AbortSignal.timeout(30_000))
    const repository = new PostgresSubExecutionRepository(database)
    const executionId = `SAEX_lifecycle_${String(process.pid)}_${String(Date.now())}`
    try {
      await repository.create(pending(executionId), SIGNAL)
      await repository.appendRecoveryMessage(
        executionId,
        0n,
        { role: 'assistant', content: '旧 owner 已确认输出' },
        SIGNAL
      )
      const claimed = await repository.claimPending(executionId, 0n, SIGNAL)
      assert.equal(claimed.revision, 1n)
      assert.deepEqual(claimed.recoveryMessages, [
        { role: 'assistant', content: '旧 owner 已确认输出' },
      ])
      await assert.rejects(
        repository.appendRecoveryMessage(
          executionId,
          0n,
          { role: 'assistant', content: '旧 owner 迟到输出' },
          SIGNAL
        ),
        /owner 已失效/u
      )

      claimed.status = 'running'
      claimed.updatedAt = new Date()
      await repository.update(claimed, SIGNAL)
      await repository.renewResumeLease(executionId, claimed.revision, new Date(), SIGNAL)
      await repository.appendRecoveryMessage(
        executionId,
        claimed.revision,
        { role: 'assistant', content: '接管 owner 输出' },
        SIGNAL
      )
      const beforeSave = await repository.getById(executionId, SIGNAL)
      assert.ok(beforeSave !== undefined)
      assert.deepEqual(beforeSave.recoveryMessages, [
        { role: 'assistant', content: '旧 owner 已确认输出' },
        { role: 'assistant', content: '接管 owner 输出' },
      ])
      const lifecycle = new SubExecutionLifecycle(repository, {
        agentId: 'agent-1',
        agentName: 'PostgreSQL 集成 Agent',
      })
      await lifecycle.save(
        identity({ executionId }),
        outcome([...beforeSave.recoveryMessages, { role: 'assistant', content: '最终结果' }]),
        undefined,
        undefined,
        beforeSave.revision,
        undefined,
        SIGNAL
      )
      const saved = await repository.getById(executionId, SIGNAL)
      assert.equal(saved?.resultSummary, '最终结果')
      assert.deepEqual(saved?.recoveryMessages, [])
    } finally {
      await database.query(
        'DELETE FROM sub_agent_executions WHERE execution_id = $1',
        [executionId],
        SIGNAL
      )
      await database.close()
    }
  })
})
