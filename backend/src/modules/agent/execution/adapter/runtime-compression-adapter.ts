import { DefaultRestorer } from 'red-bean-qing-tuan/pipeline'

import type { AgentPostCompactRestorer } from '../model/agent-execution-contract.js'

/** 创建 SDK 默认内容恢复器，并只向业务配置暴露产品 Port。 */
export function createRuntimeDefaultRestorer(): AgentPostCompactRestorer {
  return new DefaultRestorer()
}
