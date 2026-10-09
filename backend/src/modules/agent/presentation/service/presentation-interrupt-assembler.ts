import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import { toAgentJsonValue } from '../../serialization/json-value-normalizer.js'
import type { DisplayMessage } from '../model/display-message.js'
import type {
  DisplayMessageCollector,
  PresentationClock,
  PresentationContext,
} from './display-message-collector.js'

export const DISPLAY_MESSAGES_METADATA_KEY = 'display_messages'

export interface PresentationInterruptAssemblerOptions {
  readonly now?: PresentationClock | undefined
  readonly buildSections?: (() => AgentJsonValue) | undefined
}

interface PresentationInterrupt {
  readonly toolCallId: string
  readonly arguments: AgentJsonValue
}

/** 将中断的中性 Runtime 调用投影为产品 ask-card UI 模型。 */
export class PresentationInterruptAssembler {
  readonly #display: DisplayMessageCollector
  readonly #now: PresentationClock
  readonly #buildSections: (() => AgentJsonValue) | undefined

  public constructor(
    display: DisplayMessageCollector,
    options: PresentationInterruptAssemblerOptions = {}
  ) {
    this.#display = display
    this.#now = options.now ?? Date.now
    this.#buildSections = options.buildSections
  }

  public assemble(context: PresentationContext, interrupt: PresentationInterrupt): Promise<void> {
    this.assembleInterrupt(interrupt)
    installLoadedDisplayMessages(context, this.#display.messages)
    return Promise.resolve()
  }

  /** 高层 Runtime 完成后直接提交中断投影，不要求业务层构造 RuntimeContext。 */
  public assembleInterrupt(interrupt: PresentationInterrupt): void {
    const sections = filterInterruptTool(this.#buildSections?.(), interrupt.toolCallId)
    sections.push({
      type: 'card',
      card: {
        interaction_id: interrupt.toolCallId,
        status: 'pending',
        questions: questionsFrom(interrupt.arguments),
      },
      timestamp: this.#now(),
    })
    this.#display.append({ role: 'assistant', sections, timestamp: this.#now() })
  }
}

/** 向宿主 pipeline 节点提供持久化展示历史的只读快照。 */
export function installLoadedDisplayMessages(
  context: PresentationContext,
  messages: readonly DisplayMessage[]
): void {
  context.metadata.set(DISPLAY_MESSAGES_METADATA_KEY, structuredClone(messages))
}

function questionsFrom(argumentsValue: AgentJsonValue): AgentJsonValue {
  if (!isJsonObject(argumentsValue)) return []
  const questions = argumentsValue['questions']
  return questions === undefined ? [] : toAgentJsonValue(questions)
}

function filterInterruptTool(value: AgentJsonValue | undefined, callId: string): AgentJsonValue[] {
  if (!Array.isArray(value)) return []
  const sections: AgentJsonValue[] = []
  for (const section of value) {
    if (
      !isJsonObject(section) ||
      section['type'] !== 'tool_group' ||
      !Array.isArray(section['tools'])
    ) {
      sections.push(structuredClone(section))
      continue
    }
    const tools = section['tools'].filter(
      (tool): boolean =>
        !isJsonObject(tool) || (tool['call_id'] !== callId && tool['callId'] !== callId)
    )
    if (tools.length > 0) sections.push({ ...section, tools })
  }
  return sections
}

function isJsonObject(value: AgentJsonValue): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
