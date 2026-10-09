import { ChildRunError, DelegationTool, MapToolDispatcher } from 'red-bean-qing-tuan/tools'

import type {
  AgentChildRunner,
  AgentChildRunResult,
  AgentTool,
  AgentToolDispatcher,
} from '../model/agent-execution-contract.js'

/** 在唯一 Runtime Adapter 边界创建 SDK 委派工具。 */
export function createRuntimeDelegationTool(options: {
  readonly agentId: string
  readonly name: string
  readonly description: string
  readonly runner: AgentChildRunner
}): AgentTool {
  return new DelegationTool(options)
}

/** 保留 SDK 对委派部分失败的公开错误判别语义。 */
export function createRuntimeChildRunError(
  message: string,
  result: AgentChildRunResult,
  cause?: unknown
): Error {
  return new ChildRunError(message, result, cause)
}

/** 在唯一 Runtime Adapter 边界创建 SDK Tool Dispatcher。 */
export function createRuntimeToolDispatcher(tools: readonly AgentTool[]): AgentToolDispatcher {
  return new MapToolDispatcher(tools)
}
