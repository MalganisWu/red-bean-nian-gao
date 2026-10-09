import type { AgentJsonObject, AgentJsonValue } from '../model/json-value.js'
import { toAgentJsonValue } from '../serialization/json-value-normalizer.js'
import type {
  AgentTool,
  AgentToolCallContext,
  AgentToolResult,
  AgentToolSchema,
} from '../execution/model/agent-execution-contract.js'
import { normalizeError } from '../../../shared/errors/normalize-error.js'

export const ASK_USER_TOOL_NAME = 'sys_ask_user'

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

interface AskQuestion {
  readonly id: string
  readonly text: string
  readonly options: readonly string[]
  readonly select: 'single' | 'multi'
}

export class AskUserTool implements AgentTool {
  public readonly name = ASK_USER_TOOL_NAME
  public readonly schema: AgentToolSchema = {
    type: 'function',
    function: {
      name: this.name,
      description: '向用户提问并暂停当前执行，等待用户作答后继续。仅用于需要人工输入的确认场景。',
      parameters: PARAMETERS,
    },
    interrupting: true,
  }

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

/** 为全局 composition root 创建 Agent Module 拥有的提问工具。 */
export function createAskUserTool(): AgentTool {
  return new AskUserTool()
}

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

function isJsonObject(value: AgentJsonValue): value is AgentJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function abortFailure(signal: AbortSignal): Error | undefined {
  if (!signal.aborted) return undefined
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('operation aborted', 'AbortError')
}
