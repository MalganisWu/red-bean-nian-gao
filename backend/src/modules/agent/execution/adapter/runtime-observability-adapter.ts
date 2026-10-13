import { wrapChildRunner, wrapLlm, wrapToolDispatcher } from 'red-bean-qing-tuan/observability'

import type { TracerPort } from '../../../../shared/observability/tracer.js'
import type {
  AgentChildRunner,
  AgentModelAdapter,
  AgentToolDispatcher,
} from '../model/agent-execution-contract.js'

/**
 * Runtime 观测 wrapper 的防腐入口，业务 Loader 不直接依赖 SDK。
 * @param tracer 产品侧的中性 Tracer；SDK wrapper 只认它，不接触 SDK 的观测类型
 * @param adapter 被包裹的模型 adapter
 * @returns 套上 SDK 观测 wrapper 后的模型 adapter
 */
export function wrapRuntimeModel(
  tracer: TracerPort,
  adapter: AgentModelAdapter
): AgentModelAdapter {
  return wrapLlm(tracer, adapter)
}

/**
 * 给工具分发套上 SDK 的观测 wrapper；业务侧只见到产品自己的 `TracerPort`。
 * @param tracer 产品侧的中性 Tracer
 * @param dispatcher 被包裹的工具分发器
 * @returns 套上观测 wrapper 后的工具分发器
 */
export function wrapRuntimeToolDispatcher(
  tracer: TracerPort,
  dispatcher: AgentToolDispatcher
): AgentToolDispatcher {
  return wrapToolDispatcher(tracer, dispatcher)
}

/**
 * 给子运行执行器套上观测 wrapper；与上面两个同属 Runtime SDK 的防腐层。
 * @param tracer 产品侧的中性 Tracer
 * @param runner 被包裹的子运行执行器
 * @returns 套上观测 wrapper 后的子运行执行器
 */
export function wrapRuntimeChildRunner(
  tracer: TracerPort,
  runner: AgentChildRunner
): AgentChildRunner {
  return wrapChildRunner(tracer, runner)
}
