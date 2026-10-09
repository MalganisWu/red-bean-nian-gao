import {
  type AgentTaskDefinition,
  type AgentTaskExecution,
} from './../../../../../src/modules/task/model/task.js'
import type {
  SqlExecutor,
  SqlQueryResult,
  TransactionalSqlExecutor,
} from './../../../../../src/infra/database/postgres.js'

export interface RecordedQuery {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

export class RecordingDatabase implements TransactionalSqlExecutor {
  public readonly queries: RecordedQuery[] = []
  public readonly results: SqlQueryResult[] = []
  public transactions = 0

  public query(
    sql: string,
    parameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<SqlQueryResult> {
    signal.throwIfAborted()
    this.queries.push({ sql, parameters })
    return Promise.resolve(this.results.shift() ?? { rows: [], rowCount: 0 })
  }

  public async transaction<TValue>(
    signal: AbortSignal,
    operation: (transaction: SqlExecutor) => Promise<TValue>
  ): Promise<TValue> {
    signal.throwIfAborted()
    this.transactions += 1
    return operation(this)
  }
}

export const runAt = new Date('2026-08-03T10:00:00.000Z')

export const scheduledTaskRow = {
  scheduled_task_id: 'STASK_1',
  session_id: 'SESS_1',
  user_id: 'USER_1',
  task_input: '每天早上9点查天气',
  schedule_type: 'once',
  run_at: runAt,
  cron_expr: null,
  next_run_at: runAt,
  is_active: true,
  retry_count: 0,
  is_recurring: false,
  created_at: new Date('2026-08-01T00:00:00.000Z'),
}

export const task: AgentTaskDefinition = {
  taskId: 'STASK_1',
  sessionId: 'SESS_1',
  userId: 'USER_1',
  taskInput: '整理项目进展',
  scheduleType: 'once',
  runAt,
  cronExpr: '',
  nextRunAt: runAt,
  isActive: true,
  retryCount: 0,
}

export const execution: AgentTaskExecution = {
  executionId: 'TAEX_1',
  taskId: task.taskId,
  sessionId: task.sessionId,
  status: 'completed',
  scheduledAt: runAt,
  startedAt: runAt,
  completedAt: runAt,
  displayMessages: [{ role: 'assistant', content: '完成', timestamp: 1 }],
  resultType: 'text',
  resultMessage: '完成',
  delivered: false,
}
