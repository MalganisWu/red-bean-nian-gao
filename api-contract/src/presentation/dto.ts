import type { QuestionAnswerDto, QuestionDto } from '../chat/dto.js'

/** 卡片 section 的持久化载荷；`answers` 可为 null（尚未作答）或缺省。 */
export interface CardSectionDataDto {
  /** 交互 ID；与 card 帧的 `interaction_id` 同源，作答以此绑定。 */
  readonly interaction_id: string
  /** 卡片三态：pending 待作答、answered 已作答、refused 已拒答。 */
  readonly status: 'pending' | 'answered' | 'refused'
  /** 卡片包含的问题列表。 */
  readonly questions: QuestionDto[]
  /** 按问题 ID 索引的作答表；null 表示尚未作答，缺省表示旧记录未写入该字段。 */
  readonly answers?: Readonly<Record<string, QuestionAnswerDto>> | null | undefined
}

/** 工具调用的持久化投影；`status` 五态覆盖运行中、成功、失败、取消与未闭合。 */
export interface PersistedToolCardDto {
  /** 工具调用的稳定 ID，与 SSE 帧的 `call_id` 同源。 */
  readonly callId: string
  /** 工具名，与注册的 `sys_*` 标识一致。 */
  readonly name: string
  /** 工具展示标签；缺省表示由前端按名自行映射。 */
  readonly label?: string | undefined
  /** 序列化后的入参 JSON 字符串；缺省表示未采集。 */
  readonly params?: string | undefined
  /** 序列化后的结果正文；缺省表示无结果或未采集。 */
  readonly result?: string | undefined
  /** 失败原因文本；有值即表示这次调用失败。 */
  readonly error?: string | undefined
  /** 调用五态：运行中、成功、失败、取消与未闭合。 */
  readonly status: 'running' | 'success' | 'failed' | 'cancelled' | 'incomplete'
  /** 耗时展示值；历史记录里既有字符串也有数字，新写入统一用 `durationMs`。 */
  readonly duration?: string | number | undefined
  /** 耗时毫秒数；新记录优先使用它，旧记录可能缺省。 */
  readonly durationMs?: number | undefined
  /** 调用开始的时刻，epoch 毫秒；旧记录可能缺省。 */
  readonly startedAtMs?: number | undefined
}

/** reason section 里的一项：要么是一段思考文本，要么是一次工具调用。 */
export interface ReasonItemDto {
  /** 项类型：step 是一段思考文本，tool 是一次工具调用。 */
  readonly itemType: 'step' | 'tool'
  /** 项在本 section 内的展示序号，从 1 开始；缺省表示旧记录未写入。 */
  readonly index?: number | undefined
  /** 思考文本正文；仅 `itemType` 为 step 时有值。 */
  readonly content?: string | undefined
  /** 工具调用详情；仅 `itemType` 为 tool 时有值。 */
  readonly tool?: PersistedToolCardDto | undefined
}

/** 子 Agent section 的载荷；`status` 可缺省（早期写入的记录没有这个字段）。 */
export interface PersistedSubAgentSectionDataDto {
  /** 子 Agent 的 ID。 */
  readonly agent_id: string
  /** 子 Agent 的展示名。 */
  readonly agent_name: string
  /** 本次子 Agent 执行的 ID。 */
  readonly execution_id: string
  /** 子 Agent 内部产生的 section 列表。 */
  readonly sections: PersistedMessageSectionDto[]
  /** 子执行状态；缺省表示早期写入的记录没有这个字段，不能与 incomplete 混同。 */
  readonly status?:
    'running' | 'completed' | 'failed' | 'awaiting_user' | 'cancelled' | 'incomplete' | undefined
  /** 子执行的结论摘要；缺省表示尚未产出摘要。 */
  readonly result_summary?: string | undefined
  /** 父 Agent 中触发本次子执行的工具调用 ID；缺省表示旧记录未写入。 */
  readonly parent_call_id?: string | undefined
}

/** 展示消息中 section 的可辨识联合；`type` 决定其余字段，消费方必须先分支再取值。 */
export type PersistedMessageSectionDto =
  | {
      readonly type: 'reason'
      readonly items: ReasonItemDto[]
      readonly timestamp: number
      readonly duration?: number | undefined
    }
  | {
      readonly type: 'tool_group'
      readonly tools: PersistedToolCardDto[]
      readonly timestamp: number
      readonly duration?: number | undefined
    }
  | {
      readonly type: 'content'
      readonly content: string
      readonly timestamp: number
      readonly duration?: number | undefined
    }
  | { readonly type: 'card'; readonly card: CardSectionDataDto; readonly timestamp: number }
  | {
      readonly type: 'sub_agent'
      readonly items: PersistedSubAgentSectionDataDto
      readonly timestamp: number
    }

/** 消息由定时任务产生时的来源信息；`completed_at` 可缺省（执行尚未结束）。 */
export interface ScheduledTaskMetaDto {
  /** 定时任务 ID。 */
  readonly task_id: string
  /** 定时任务展示名。 */
  readonly task_name: string
  /** 该次任务执行的终态：completed 成功、failed 失败。 */
  readonly status: 'completed' | 'failed'
  /** 该次任务执行的 ID。 */
  readonly execution_id: string
  /** 计划触发时刻，epoch 毫秒。 */
  readonly scheduled_at: number
  /** 实际完成时刻，epoch 毫秒；缺省表示执行尚未结束。 */
  readonly completed_at?: number | undefined
}

/** 展示元信息；`process_status` 目前只有 `cancelled` 一个取值，用于标记被中断的过程块。 */
export interface DisplayMessageMetaDto {
  /** 消息由定时任务产生时的来源信息；缺省表示消息不是定时任务产生的。 */
  readonly scheduled_task?: ScheduledTaskMetaDto | undefined
  /** 本轮过程块的开始时刻，epoch 毫秒；缺省表示旧记录未写入。 */
  readonly run_started_at?: number | undefined
  /** 过程块状态；只有 cancelled 一个取值，标记被中断的过程块，缺省表示正常。 */
  readonly process_status?: 'cancelled' | undefined
}

/** 会话详情和任务执行结果共同使用的持久化消息 wire DTO。 */
export interface PersistedDisplayMessageDto {
  /** 消息角色：user 是用户输入，assistant 是模型输出。 */
  readonly role: 'user' | 'assistant'
  /** 纯文本正文；有 section 的消息可能缺省正文。 */
  readonly content?: string | undefined
  /** 结构化展示片段；缺省表示这条消息只有纯文本。 */
  readonly sections?: PersistedMessageSectionDto[] | undefined
  /** 消息来源标识（如 timer）；缺省表示由普通对话产生。 */
  readonly source?: string | undefined
  /** 展示元信息；缺省表示没有额外元数据。 */
  readonly meta?: DisplayMessageMetaDto | undefined
  /** 消息产生时刻，epoch 毫秒。 */
  readonly timestamp: number
}
