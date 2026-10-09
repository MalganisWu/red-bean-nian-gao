/** SSE 事件名称的运行时唯一集合；与纯数据 DTO 分文件维护。 */
export const SSE_EVENT_TYPES = {
  START: 'start',
  TOKEN: 'token',
  STATUS: 'status',
  TOOL_START: 'tool_start',
  TOOL_RESULT: 'tool_result',
  CARD: 'card',
  DONE: 'done',
  ERROR: 'error',
  HEARTBEAT: 'heartbeat',
  REASON: 'reason',
  COMPACTION: 'compaction',
  AGENT_EVENT: 'agent_event',
} as const

export type SSEEventType = (typeof SSE_EVENT_TYPES)[keyof typeof SSE_EVENT_TYPES]
