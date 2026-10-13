import type { AgentJsonObject, AgentJsonValue } from '../../model/json-value.js'
import { toAgentJsonValue } from '../../serialization/json-value-normalizer.js'
import type { DisplayMessage } from '../model/display-message.js'
import type {
  DisplayMessageCollector,
  PresentationClock,
  PresentationContext,
} from './display-message-collector.js'

/** 展示历史在 pipeline metadata 里的键；存的是深拷贝快照，节点不应就地修改。 */
export const DISPLAY_MESSAGES_METADATA_KEY = 'display_messages'

/** 构造选项；两个可注入点分别控制时间戳来源与 section 的构造方式。 */
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

  /**
   * 组装中断投影并写入 pipeline metadata：先本地追加卡片，再把展示历史快照装进 context。
   * @param context Runtime 回调上下文；其 metadata 是节点之间共享的可变袋，快照写在这里
   * @param interrupt 中断的中性调用信息（toolCallId 与 arguments）
   */
  public assemble(context: PresentationContext, interrupt: PresentationInterrupt): Promise<void> {
    this.assembleInterrupt(interrupt)
    installLoadedDisplayMessages(context, this.#display.messages)
    return Promise.resolve()
  }

  /**
   * 高层 Runtime 完成后直接提交中断投影，不要求业务层构造 RuntimeContext。
   * @param interrupt 中断的中性调用信息；据此摘除发起中断的工具并替换为 pending 的 ask-card
   */
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

/**
 * 向宿主 pipeline 节点提供持久化展示历史的只读快照。
 * @param context Runtime 回调上下文；快照写入其 metadata 的展示历史键
 * @param messages 展示历史；`structuredClone` 后存入，节点不应就地修改
 */
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

/**
 * 从工具组里摘掉发起中断的那个工具，换成卡片来呈现。
 *
 * 摘掉的理由：中断工具永远不会有 tool_result，留着就是界面上一个永远转圈的工具。
 * 组里还有其他工具时保留该组，全被摘光就整组丢弃——空组渲染出来是一片空白。
 *
 * 两个键名都判（`call_id` 与 `callId`）是因为数据来源有两处：
 * 持久化 section 用 snake_case，SDK 侧的事件用 camelCase，投影层不做归一化，
 * 这里两种都得认。
 */
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
