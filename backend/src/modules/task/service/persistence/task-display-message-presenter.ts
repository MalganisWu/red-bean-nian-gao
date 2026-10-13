import { isPersistedDisplayMessage, type PersistedDisplayMessageDto } from '@red-bean/api-contract'

import { serializeDisplayMessage, type DisplayMessage } from './../../../agent/public-api.js'

/**
 * 把 Task 持有的 Agent 展示结果投影为稳定持久化/API 字段。
 * 这是 Task 自己的纯字段映射，不向 Agent Module 索取 serializer 行为 Port。
 *
 * @param message - 领域展示消息；承载 Agent 运行过程产出的卡片、分段与元数据。
 * @returns 通过共享契约校验的持久化 DTO；不符合契约时抛错，不产出残缺结构。
 */
export function toTaskDisplayMessageDto(message: DisplayMessage): PersistedDisplayMessageDto {
  const payload = serializeDisplayMessage(message)
  if (!isPersistedDisplayMessage(payload)) {
    throw new Error('任务展示消息不符合共享 API 契约')
  }
  return payload
}
