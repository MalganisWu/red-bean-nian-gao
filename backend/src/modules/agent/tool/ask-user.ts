import type { AgentJsonObject, AgentJsonValue } from '../model/json-value.js'
import { toAgentJsonValue } from '../serialization/json-value-normalizer.js'
import type {
  AgentTool,
  AgentToolCallContext,
  AgentToolResult,
  AgentToolSchema,
} from '../execution/model/agent-execution-contract.js'
import { normalizeError } from '../../../shared/errors/normalize-error.js'

/** 提问工具名；pipeline 与卡片投影层据此识别「这次的挂起是一次提问」。 */
export const ASK_USER_TOOL_NAME = 'sys_ask_user'

/**
 * 提问工具的入参 JSON Schema，模型可见的契约来源，字段与 `AskQuestion` 一一对应。
 * 在模块级用 `Object.freeze` 冻结：它是被所有调用共享的常量，任何一次调用都不该改写它的字段。
 */
const PARAMETERS: AgentJsonObject = Object.freeze({
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: '问题唯一标识，答案回传时按此 id 对应',
          },
          text: {
            type: 'string',
            description: '问题文本，向用户展示的提问内容',
          },
          options: {
            type: 'array',
            minItems: 1,
            items: { type: 'string' },
            description: '可选项列表，至少 1 个',
          },
          select: {
            type: 'string',
            enum: ['single', 'multi'],
            description: '单选或多选，默认 single',
          },
        },
        required: ['id', 'text', 'options'],
      },
      description: '要询问的问题列表，至少 1 个',
    },
  },
  required: ['questions'],
})

/** 校验后的问题结构；既是 `sys_ask_user` 入参的领域形态，也是挂起卡片渲染的数据源。 */
interface AskQuestion {
  /** 问题唯一标识；用户答案按它回填对应问题。 */
  readonly id: string
  /** 问题文本；向用户展示的提问内容。 */
  readonly text: string
  /** 可选项列表；至少 1 个。 */
  readonly options: readonly string[]
  /** 单选或多选；缺省补为 `single`。 */
  readonly select: 'single' | 'multi'
}

/**
 * 系统内置的提问工具；只做参数校验与挂起，不产生任何正文结果。
 *
 * `interrupting: true` 是它成立的前提——Runtime 靠这个**静态声明**在调用处形成中断屏障。
 * 少了它，这个工具会退化成一个「立刻返回空内容」的普通工具跑完，用户永远看不到卡片。
 */
export class AskUserTool implements AgentTool {
  /** 工具对外名称（`sys_ask_user`）；pipeline 与卡片投影层据此识别「这次挂起是一次提问」。 */
  public readonly name = ASK_USER_TOOL_NAME
  /** 工具 schema；`interrupting: true` 是它成立的前提，Runtime 靠该静态声明在调用处形成中断屏障。 */
  public readonly schema: AgentToolSchema = {
    type: 'function',
    function: {
      name: this.name,
      description: '向用户提问并暂停当前执行，等待用户作答后继续。仅用于需要人工输入的确认场景。',
      parameters: PARAMETERS,
    },
    interrupting: true,
  }

  /**
   * 校验参数并挂起：不产生正文结果，只返回 `interrupt` 信号等待用户作答。
   * 已中止时直接 reject；参数非法或拿不到 callId 时同样 reject，绝不静默退化成普通空结果工具。
   * @param value 工具入参 JSON；按 questions 结构逐字段校验
   * @param context 本次调用上下文；用其 callId 作为卡片的 interaction_id
   * @param signal 中止信号；已中止时以 signal.reason 为由 reject
   * @returns 带 `interrupt` 信号的工具结果（content 为空），Runtime 据此暂停执行
   */
  public execute(
    value: AgentJsonValue,
    context: AgentToolCallContext,
    signal: AbortSignal
  ): Promise<AgentToolResult> {
    const aborted = abortFailure(signal)
    if (aborted !== undefined) return Promise.reject(aborted)
    try {
      parseQuestions(value)
      if (context.callId === '') {
        throw new Error('无法确定本次调用的 call_id，拒绝挂起')
      }
      return Promise.resolve({
        content: '',
        signal: {
          kind: 'interrupt',
          payload: toAgentJsonValue({
            kind: 'ask',
            status: 'awaiting_user',
            interaction_id: context.callId,
          }),
        },
      })
    } catch (error: unknown) {
      return Promise.reject(normalizeError(error))
    }
  }
}

/**
 * 为全局 composition root 创建 Agent Module 拥有的提问工具。
 * @returns 新的 AskUserTool 实例
 */
export function createAskUserTool(): AgentTool {
  return new AskUserTool()
}

/**
 * 把不可信的工具入参收窄成 `AskQuestion` 列表，逐字段校验并在首个非法处抛出中文错误。
 * 问题是挂起卡片的唯一来源：宁可整次拒绝，也不能让半个问题流进交互流程，
 * 更不能带着重复 id 或缺失选项进入用户作答环节。
 *
 * @param value - 工具入参原始 JSON，来自模型输出，按不可信输入处理。
 * @returns 校验通过的问题列表；id 保证唯一，`select` 缺失时补为 `single`。
 */
function parseQuestions(value: AgentJsonValue): readonly AskQuestion[] {
  if (!isJsonObject(value)) throw new Error('参数必须是对象')
  const questions = value['questions']
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('questions 至少需要 1 个问题')
  }

  const parsed: AskQuestion[] = []
  const ids = new Set<string>()
  for (const rawQuestion of questions) {
    if (!isJsonObject(rawQuestion)) throw new Error('问题必须是对象')
    const id = rawQuestion['id']
    const text = rawQuestion['text']
    const options = rawQuestion['options']
    const select = rawQuestion['select'] ?? 'single'
    if (typeof id !== 'string' || id === '') throw new Error('问题缺少 id')
    if (typeof text !== 'string' || text === '') {
      throw new Error(`问题 ${JSON.stringify(id)} 缺少 text`)
    }
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      !options.every((option): option is string => typeof option === 'string')
    ) {
      throw new Error(`问题 ${JSON.stringify(id)} 缺少 options`)
    }
    if (select !== 'single' && select !== 'multi') {
      throw new Error(`问题 ${JSON.stringify(id)} 的 select 必须是 "single" 或 "multi"`)
    }
    if (ids.has(id)) throw new Error(`问题 id 重复: ${JSON.stringify(id)}`)
    ids.add(id)
    parsed.push({ id, text, options, select })
  }
  return parsed
}

/**
 * 判定一个 JSON 值是否为普通对象，先排除 `null` 与数组再交给字段校验。
 *
 * @param value - 待判定的 Agent JSON 值。
 * @returns 是对象时为 true，并把类型收窄为 `AgentJsonObject`。
 */
function isJsonObject(value: AgentJsonValue): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 从中止信号取出应作为失败原因的 Error，供调用方直接 reject。
 * 信号未中止时返回 `undefined`；reason 不是 Error 时退化成 `AbortError`，
 * 保证对外 reject 的原因始终是 Error，而不是任意的 abort reason。
 *
 * @param signal - 本次工具调用的中止信号。
 * @returns 已中止时的失败原因；未中止为 `undefined`。
 */
function abortFailure(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) return undefined
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('operation aborted', 'AbortError')
}
