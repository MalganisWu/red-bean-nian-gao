import { SSE_EVENT_TYPES, type SSEEventType } from '@red-bean/api-contract'

export {
  SSE_EVENT_TYPES,
  isCardEvent,
  isCompactionEvent,
  isDoneEvent,
  isErrorEvent,
  isHeartbeatEvent,
  isReasonEvent,
  isStartEvent,
  isStatusEvent,
  isSubAgentEnvelope,
  isTokenEvent,
  isToolResultEvent,
  isToolStartEvent,
} from '@red-bean/api-contract'
export type {
  CardEventDto as CardEvent,
  CompactionEventDto as CompactionEvent,
  DoneEventDto as DoneEvent,
  ErrorEventDto as ErrorEvent,
  HeartbeatEventDto as HeartbeatEvent,
  ReasonEventDto as ReasonEvent,
  SSEEventType,
  StartEventDto as StartEvent,
  StatusEventDto as StatusEvent,
  SubAgentEnvelopeDto as SubAgentEnvelopePayload,
  TokenEventDto as TokenEvent,
  ToolResultEventDto as ToolResultEvent,
  ToolStartEventDto as ToolStartEvent,
} from '@red-bean/api-contract'

/** 解析后的 SSE 帧：事件名 + **尚未校验**的原始载荷（形状由调用方按 `eventType` 判）。 */
export interface ParsedSSEEvent {
  /** 事件名；已由解析层校验为契约中声明的事件类型。 */
  readonly eventType: SSEEventType
  /** 原始载荷；形状尚未校验，由调用方按 eventType 收窄。 */
  readonly data: unknown
}

/**
 * 判定字符串是否为已知事件名；未知事件名应被调用方丢弃，而不是当成解析失败。
 *
 * @param value - SSE 帧的 event 名（原始字符串）；空串或契约未声明的事件名判否。
 * @returns 是否为契约中已声明的事件类型。
 */
export function isWireSSEEventType(value: string): value is SSEEventType {
  return Object.values(SSE_EVENT_TYPES).some((eventType) => eventType === value)
}
