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

export function wrapRuntimeToolDispatcher(
  tracer: TracerPort,
  dispatcher: AgentToolDispatcher
): AgentToolDispatcher {
  return wrapToolDispatcher(tracer, dispatcher)
}

export function wrapRuntimeChildRunner(
  tracer: TracerPort,
  runner: AgentChildRunner
): AgentChildRunner {
  return wrapChildRunner(tracer, runner)
}
