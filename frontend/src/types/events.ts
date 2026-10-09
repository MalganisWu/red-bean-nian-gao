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

export interface ParsedSSEEvent {
  readonly eventType: SSEEventType
  readonly data: unknown
}

export function isWireSSEEventType(value: string): value is SSEEventType {
  return Object.values(SSE_EVENT_TYPES).some((eventType) => eventType === value)
}
