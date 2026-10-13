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
  /** 时间戳来源；缺省用 `Date.now`，注入后测试可产出确定的时间。 */
  readonly now?: PresentationClock | undefined
  /** 构造当前 section 列表的方法；缺省则从空数组起拼投影。 */
  readonly buildSections?: (() => AgentJsonValue) | undefined
}

/** 中断的中性调用信息：投影只依赖它的 toolCallId 与 arguments，不感知具体是哪个工具。 */
interface PresentationInterrupt {
  /** 发起中断的工具调用标识；用作卡片的 interaction_id，并从工具组里摘除该工具。 */
  readonly toolCallId: string
  /** 中断工具携带的原始参数；据此取出 questions 投影为卡片。 */
  readonly arguments: AgentJsonValue
}

/** 将中断的中性 Runtime 调用投影为产品 ask-card UI 模型。 */
export class PresentationInterruptAssembler {
  /** 展示消息收集器；中断卡片既追加给它，也取它的快照写进 metadata。 */
  readonly #display: DisplayMessageCollector
  /** 时间戳来源；可注入，测试据此产出确定的时间。 */
  readonly #now: PresentationClock
  /** 构造当前 section 列表的方法；缺省则从空数组起拼投影。 */
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

/**
 * 从工具参数里取出 questions 投影为 JSON；参数不是对象或没有 questions 时返回空数组，
 * 保证 ask-card 的 questions 字段始终存在——缺失时前端会渲染成一张没有任何选项的卡片。
 * @param argumentsValue 中断工具携带的参数原始值；非 JSON 对象一律按「无问题」处理
 * @returns questions 的 JSON 投影；无可展示问题时为空数组
 */
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
 * @param value buildSections 产出的 section 值；非数组按空处理，未摘除的 section 深拷贝以免污染来源
 * @param callId 发起中断的调用 ID；命中的工具从组里摘除，`call_id` 与 `callId` 两种键名都判
 * @returns 摘除中断工具后的 section 数组；一组工具被摘光时整组丢弃
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

/**
 * 判定值是否为非数组的普通对象；投影层用它把 AgentJsonValue 窄化到可按键访问的对象。
 * @param value 待判定的 JSON 值
 * @returns 是非数组对象时为 true
 */
function isJsonObject(value: AgentJsonValue): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
