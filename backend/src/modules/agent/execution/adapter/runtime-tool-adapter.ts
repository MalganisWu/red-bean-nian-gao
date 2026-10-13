import { ChildRunError, DelegationTool, MapToolDispatcher } from 'red-bean-qing-tuan/tools'

import type {
  AgentChildRunner,
  AgentChildRunResult,
  AgentTool,
  AgentToolDispatcher,
} from '../model/agent-execution-contract.js'

/**
 * 在唯一 Runtime Adapter 边界创建 SDK 委派工具。
 * @param options 子 Agent 的标识、名称、描述与子运行执行器（原样交给 SDK 构造器）
 * @returns 可直接注册进工具目录的 SDK 委派工具
 */
export function createRuntimeDelegationTool(options: {
  readonly agentId: string
  readonly name: string
  readonly description: string
  readonly runner: AgentChildRunner
}): AgentTool {
  return new DelegationTool(options)
}

/**
 * 保留 SDK 对委派部分失败的公开错误判别语义。
 * @param message 错误描述
 * @param result 子运行的失败结果快照，供上层持久化部分进展
 * @param cause 触发失败的原因（可选），保留原始错误链
 * @returns 携带 `result` 的 SDK ChildRunError，上层据此识别「委派部分失败」
 */
export function createRuntimeChildRunError(
  message: string,
  result: AgentChildRunResult,
  cause?: unknown
): Error {
  return new ChildRunError(message, result, cause)
}

/**
 * 在唯一 Runtime Adapter 边界创建 SDK Tool Dispatcher。
 * @param tools 工具目录（系统工具 + 委派工具）；SDK 按名称建立分派索引
 * @returns 可直接交给 Runtime 的 SDK 工具分发器
 */
export function createRuntimeToolDispatcher(tools: readonly AgentTool[]): AgentToolDispatcher {
  return new MapToolDispatcher(tools)
}
