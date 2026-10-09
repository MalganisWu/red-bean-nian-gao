import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  RUN_FACT_SCHEMA_VERSION,
  type RunAssistantFact,
  type RunToolFact,
  type RunUserFact,
} from '../../../../src/modules/agent/run-facts/model/run-fact.js'
import {
  RUN_FACT_STORE_ERROR_CODES,
  RunFactStoreError,
} from '../../../../src/modules/agent/run-facts/model/run-fact-store-error.js'
import { parseRunFacts } from '../../../../src/modules/agent/run-facts/persistence/run-fact-row-mapper.js'

const assistantFact: RunAssistantFact = {
  type: 'assistant',
  at: 1_000,
  durationMs: 120,
  usage: { promptTokens: 10, completionTokens: 4, cacheReadTokens: null },
  attempts: [
    {
      attempt: 1,
      startedAt: 900,
      endedAt: 1_000,
      usage: null,
      error: 'LLM stream failed',
    },
  ],
  thinking: '先分析',
  content: '完成',
  schemaVersion: RUN_FACT_SCHEMA_VERSION,
}

const userFact: RunUserFact = {
  type: 'user',
  content: '开始',
  at: 500,
  schemaVersion: RUN_FACT_SCHEMA_VERSION,
}

const toolFact: RunToolFact = {
  type: 'tool',
  callId: 'call_1',
  name: 'sys_search',
  params: { query: '库存' },
  result: '找到 3 条',
  startedAt: 1_100,
  durationMs: 30,
  schemaVersion: RUN_FACT_SCHEMA_VERSION,
}

void describe('run fact 事实日志版本纪律', () => {
  void it('parses the three message-level fact types into the domain union', () => {
    assert.deepEqual(parseRunFacts([userFact, assistantFact, toolFact]), [
      userFact,
      assistantFact,
      toolFact,
    ])
  })

  void it('skips unknown fact types that carry the ignorable marker', () => {
    // 未来版本新增的事实类型；旧读取端按 ignorable 纪律跳过而不是误读。
    const futureFact = { type: 'compaction', ignorable: true, payload: { before: 1 } }
    assert.deepEqual(parseRunFacts([userFact, futureFact]), [userFact])
  })

  void it('rejects unknown fact types without the ignorable marker', () => {
    // G2 起 compaction 是已知类型；未知识别继续用尚未存在的事实类型。
    assert.throws(
      () => parseRunFacts([{ type: 'context_injection', payload: {} }]),
      /未知的事实类型/u
    )
  })

  void it('skips future schema versions of known types only when marked ignorable', () => {
    const newer = { ...userFact, schemaVersion: RUN_FACT_SCHEMA_VERSION + 1, ignorable: true }
    assert.deepEqual(parseRunFacts([newer]), [])
    assert.throws(
      () => parseRunFacts([{ ...userFact, schemaVersion: RUN_FACT_SCHEMA_VERSION + 1 }]),
      /事实日志 schema 版本/u
    )
  })

  void it('parses session-level compaction facts with the three terminal statuses', () => {
    const compaction = {
      type: 'compaction',
      at: 2_000,
      trigger: 'auto',
      beforeTokens: 100_000,
      afterTokens: 8_100,
      messages: 42,
      durationMs: 4_300,
      status: 'success',
      schemaVersion: RUN_FACT_SCHEMA_VERSION,
    }
    assert.deepEqual(parseRunFacts([compaction]), [compaction])
    // 失败/中断态与不可测耗时（null）同样合法：读取端按三态渲染。
    const failed = { ...compaction, status: 'failed', durationMs: null }
    const interrupted = { ...compaction, status: 'interrupted', trigger: 'manual' }
    assert.deepEqual(parseRunFacts([failed, interrupted]), [failed, interrupted])
  })

  void it('rejects malformed records instead of silently coercing them', () => {
    assert.throws(() => parseRunFacts('nope'), /事实日志/u)
    assert.throws(() => parseRunFacts([{ type: 'user', at: 1 }]), /事实日志/u)
    assert.throws(() => parseRunFacts([{ ...toolFact, params: 'not-json' }]), /事实日志/u)
  })

  void it('pins the fact shape: trajectory-DTO vocabulary (v / usage.input / attempt "1/1") is rejected', () => {
    // 固化形状契约：session_runs.facts 的合法形状由 model 定义（schemaVersion +
    // usage{promptTokens,completionTokens,cacheReadTokens} + attempt 数值与起止），
    // 轨迹 wire DTO 的词汇（input/output/cache、attempt "1/1"、status）不是合法事实形状。
    // 手工造数或外部写入使用该词汇时，读取端以 RunFactStoreError 明确拒绝（不静默误读），
    // 由轨迹查询端降级为 display_messages 投影而不是 500。
    const handWritten = [
      { type: 'user', content: '帮我调研…', at: 1_789_089_731_000, v: 1 },
      {
        type: 'assistant',
        at: 1_789_089_731_000,
        durationMs: 4300,
        usage: { input: 3218, output: 412, cache: 0 },
        attempts: [
          {
            attempt: '1/1',
            durationMs: 4300,
            usage: { input: 3218, output: 412, cache: 0 },
            status: 'success',
          },
        ],
        thinking: '先分析需求',
        content: '',
        v: 1,
      },
      {
        type: 'tool',
        callId: 'c1',
        name: 'web_search',
        params: { query: '…' },
        result: '找到资料',
        startedAt: 1_789_089_732_000,
        durationMs: 1800,
        v: 1,
      },
    ]
    assert.throws(
      () => parseRunFacts(handWritten),
      (error: unknown): boolean => {
        assert.ok(error instanceof RunFactStoreError)
        assert.equal(error.code, RUN_FACT_STORE_ERROR_CODES.FACTS_UNREADABLE)
        // 第一处形状差异即被拦截：缺 schemaVersion（只有 v）。
        assert.match(error.message, /schema 版本不受支持/u)
        return true
      }
    )
  })
})
