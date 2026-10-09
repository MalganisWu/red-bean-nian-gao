import { parseCheckpoint, serializeCheckpoint, type Checkpoint } from 'red-bean-qing-tuan'
import type { RawMessage } from 'red-bean-qing-tuan/pipeline'

import type { StoredRuntimeState } from '../../src/modules/agent/execution/model/runtime-state.js'

/** 测试专用的合法 Runtime 状态工厂，避免测试伪造 SDK 私有 JSON。 */
export function runtimeState(
  messages: readonly RawMessage[] = [],
  overrides: Partial<Checkpoint> = {}
): StoredRuntimeState {
  const checkpoint: Checkpoint = {
    version: 1,
    threadId: 'session-1',
    userId: 'user-1',
    status: 'completed',
    messages: messages.map((message): RawMessage => structuredClone(message)),
    contentRefs: [],
    lastResumeInterrupt: '',
    tokensUsed: 0,
    finishReason: '',
    ...overrides,
  }
  return {
    engine: 'qing-tuan',
    version: checkpoint.version,
    payload: serializeCheckpoint(checkpoint),
  }
}

export function runtimeMessages(state: StoredRuntimeState | undefined): readonly RawMessage[] {
  return state === undefined ? [] : parseCheckpoint(state.payload).messages
}
