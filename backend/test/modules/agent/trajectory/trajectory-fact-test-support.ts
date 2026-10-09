/**
 * 事实日志投影测试的共享 fixture 工厂：run 容器、四类事实与子执行记录的构造。
 * 仅测试使用（`*-test-support` 约定），不参与 `*.test.js` 收集。
 */

import type { SessionRunRecord } from '../../../../src/modules/agent/run-facts/model/session-run.js'
import { SESSION_RUN_STATUSES } from '../../../../src/modules/agent/run-facts/model/session-run.js'
import {
  RUN_FACT_SCHEMA_VERSION,
  type RunAssistantFact,
  type RunToolFact,
  type RunToolStatus,
  type RunUserFact,
} from '../../../../src/modules/agent/run-facts/model/run-fact.js'
import type { AgentJsonObject } from '../../../../src/modules/agent/model/json-value.js'
import type { SubExecutionRecord } from '../../../../src/modules/agent/subagent/model/sub-execution.js'

export const STARTED_AT = 1_000_000

export function userFact(content: string, at: number): RunUserFact {
  return { type: 'user', content, at, schemaVersion: RUN_FACT_SCHEMA_VERSION }
}

export function assistantFact(input: {
  readonly at: number
  readonly durationMs?: number
  readonly promptTokens?: number
  readonly completionTokens?: number
  readonly cacheReadTokens?: number | null
  readonly attempts?: RunAssistantFact['attempts']
  readonly thinking?: string
  readonly content?: string
}): RunAssistantFact {
  const usage =
    input.promptTokens === undefined
      ? null
      : {
          promptTokens: input.promptTokens,
          completionTokens: input.completionTokens ?? 0,
          cacheReadTokens: input.cacheReadTokens ?? null,
        }
  return {
    type: 'assistant',
    at: input.at,
    durationMs: input.durationMs ?? 100,
    usage,
    attempts: input.attempts ?? [],
    thinking: input.thinking ?? '',
    content: input.content ?? '',
    schemaVersion: RUN_FACT_SCHEMA_VERSION,
  }
}

export function toolFact(input: {
  readonly callId: string
  readonly name: string
  readonly startedAt: number
  readonly result?: string
  readonly error?: string
  readonly durationMs?: number
  readonly status?: RunToolStatus
  readonly params?: AgentJsonObject | null
}): RunToolFact {
  return {
    type: 'tool',
    callId: input.callId,
    name: input.name,
    params: input.params ?? null,
    ...(input.result === undefined ? {} : { result: input.result }),
    ...(input.error === undefined ? {} : { error: input.error }),
    startedAt: input.startedAt,
    durationMs: input.durationMs ?? 25,
    ...(input.status === undefined ? {} : { status: input.status }),
    schemaVersion: RUN_FACT_SCHEMA_VERSION,
  }
}

export function run(input: {
  readonly runId: string
  readonly runIndex: number
  readonly facts: SessionRunRecord['facts']
  readonly status?: SessionRunRecord['status']
  readonly startedAt?: number
  readonly endedAt?: number | null
  readonly error?: string
}): SessionRunRecord {
  return {
    runId: input.runId,
    sessionId: 'SESS_1',
    userId: 'USER_1',
    runIndex: input.runIndex,
    provider: 'openai',
    model: 'deepseek-chat',
    contextWindow: null,
    status: input.status ?? SESSION_RUN_STATUSES.COMPLETED,
    ...(input.error === undefined ? {} : { error: input.error }),
    startedAt: input.startedAt ?? STARTED_AT,
    /* 显式 null 表示"尚未终结"（running run 的真实形态），不能被默认值吞掉 */
    endedAt: input.endedAt === undefined ? (input.startedAt ?? STARTED_AT) + 500 : input.endedAt,
    facts: input.facts,
    schemaVersion: 1,
  }
}

export function subExecution(input: {
  readonly parentCallId: string
  readonly tokensUsed: number
}): SubExecutionRecord {
  return {
    executionId: `SAEX_${input.parentCallId}`,
    sessionId: 'SESS_1',
    requestId: 'RUN_1',
    agentId: 'AGENT_1',
    agentName: '检索员',
    userId: 'USER_1',
    userMessage: '检索',
    display: [],
    recoveryMessages: [],
    tokensUsed: input.tokensUsed,
    elapsedMilliseconds: 320,
    status: 'completed',
    createdAt: new Date(STARTED_AT),
    updatedAt: new Date(STARTED_AT),
    parentCallId: input.parentCallId,
    revision: 0n,
  }
}
