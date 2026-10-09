/** 定时任务管理工具的稳定名称；工具实现与调度执行侧的排除名单共用一个来源。 */
export const SCHEDULED_TASK_MANAGE_TOOL_NAME = 'sys_scheduled_task_manage'

/** 任务输入上限（按 code point 计量）：工具侧校验与执行侧截断共用，避免改一处另一处静默失配。 */
export const MAX_TASK_INPUT_LENGTH = 4_000
