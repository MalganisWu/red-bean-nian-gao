import { wrapChildRunner, wrapLlm, wrapToolDispatcher } from 'red-bean-qing-tuan/observability'

import type { TracerPort } from '../../../../shared/observability/tracer.js'
import type {
  AgentChildRunner,
  AgentModelAdapter,
  AgentToolDispatcher,
} from '../model/agent-execution-contract.js'

/** Runtime 观测 wrapper 的防腐入口，业务 Loader 不直接依赖 SDK。 */
export function wrapRuntimeModel(
  tracer: TracerPort,
  adapter: AgentModelAdapter
): AgentModelAdapter {
  return wrapLlm(tracer, adapter)
}

/** 给工具分发套上 SDK 的观测 wrapper；业务侧只见到产品自己的 `TracerPort`。 */
export function wrapRuntimeToolDispatcher(
  tracer: TracerPort,
  dispatcher: AgentToolDispatcher
): AgentToolDispatcher {
  return wrapToolDispatcher(tracer, dispatcher)
}

/** 给子运行执行器套上观测 wrapper；与上面两个同属 Runtime SDK 的防腐层。 */
export function wrapRuntimeChildRunner(
  tracer: TracerPort,
  runner: AgentChildRunner
): AgentChildRunner {
  return wrapChildRunner(tracer, runner)
}
