import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import type { ExecutionViewState, Task, TaskExecution, TaskListItem } from '@/types/task'
import { AppError, extractErrorMessage } from '@/lib/errors'
import {
  fetchSessionTasks,
  fetchTasks,
  fetchTask,
  updateTask,
  deleteTask as deleteTaskApi,
  fetchExecutions,
  fetchExecution,
  fetchExecutionViewStates,
  updateExecutionViewState,
} from '@/services/api/task'

interface TaskState {
  sessionTasks: TaskListItem[]
  sessionTasksLoading: boolean
  tasks: TaskListItem[]
  tasksLoading: boolean
  tasksNextCursor: string | null
  currentTask: Task | null
  currentTaskLoading: boolean
  executions: TaskExecution[]
  executionsLoading: boolean
  executionsNextCursor: string | null
  activeExecution: TaskExecution | null
  activeExecutionLoading: boolean
  executionViewStates: Record<string, ExecutionViewState>
  executionViewStatesLoaded: Record<string, boolean>
  executionViewStatesLoading: Record<string, boolean>
  executionViewStatesFailed: Record<string, boolean>
  /** 最近一次请求失败的错误消息（三态 error 态） */
  error: string | null
}

interface TaskActions {
  loadSessionTasks: (sessionId: string) => Promise<void>
  loadTasks: (cursor?: string) => Promise<void>
  loadTaskDetail: (taskId: string) => Promise<void>
  loadExecutions: (taskId: string, cursor?: string) => Promise<void>
  loadExecutionDetail: (taskId: string, executionId: string) => Promise<void>
  loadExecutionViewStates: (executionIds: string[]) => Promise<void>
  markExecutionSeen: (taskId: string, executionId: string) => Promise<boolean>
  setExecutionCollapsed: (
    taskId: string,
    executionId: string,
    collapsed: boolean
  ) => Promise<boolean>
  toggleTaskActive: (taskId: string) => Promise<void>
  deleteTask: (taskId: string) => Promise<void>
  reset: () => void
}

const initialState: TaskState = {
  sessionTasks: [],
  sessionTasksLoading: false,
  tasks: [],
  tasksLoading: false,
  tasksNextCursor: null,
  currentTask: null,
  currentTaskLoading: false,
  executions: [],
  executionsLoading: false,
  executionsNextCursor: null,
  activeExecution: null,
  activeExecutionLoading: false,
  executionViewStates: {},
  executionViewStatesLoaded: {},
  executionViewStatesLoading: {},
  executionViewStatesFailed: {},
  error: null,
}

const EMPTY_VIEW_STATE = (executionId: string): ExecutionViewState => ({
  execution_id: executionId,
  seen_at: null,
  collapsed_override: null,
  updated_at: null,
})

/**
 * 把批量拉回的视图状态并入本地。
 * GET 发出后若用户已产生本地更新，不能再用旧快照覆盖它，因此只用 `returned` 覆盖
 * 那些既未加载过、也未标记失败的条目；其余三张索引表同步置为「已加载、未在途、未失败」。
 */
function withLoadedViewStates(
  current: TaskState,
  missingIDs: readonly string[],
  returned: ReadonlyMap<string, ExecutionViewState>
): Partial<TaskState> {
  const executionViewStates = { ...current.executionViewStates }
  const executionViewStatesLoaded = { ...current.executionViewStatesLoaded }
  const executionViewStatesLoading = { ...current.executionViewStatesLoading }
  const executionViewStatesFailed = { ...current.executionViewStatesFailed }
  for (const executionId of missingIDs) {
    if (
      !current.executionViewStatesLoaded[executionId] ||
      current.executionViewStatesFailed[executionId]
    ) {
      executionViewStates[executionId] = returned.get(executionId) ?? EMPTY_VIEW_STATE(executionId)
    }
    executionViewStatesLoaded[executionId] = true
    executionViewStatesLoading[executionId] = false
    executionViewStatesFailed[executionId] = false
  }
  return {
    executionViewStates,
    executionViewStatesLoaded,
    executionViewStatesLoading,
    executionViewStatesFailed,
  }
}

function laterTimestamp(current: string | null, incoming: string | null): string | null {
  if (!current) return incoming
  if (!incoming) return current
  return incoming > current ? incoming : current
}

const retryDelay = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 250 * 2 ** attempt))

let executionDetailRequestSerial = 0
let taskDetailRequestSerial = 0
let executionListRequestSerial = 0

type TaskStore = TaskState & TaskActions

/** 任务 store：会话内任务、任务详情与执行列表；每类请求带自增序号，用于丢弃过期响应。 */
export const useTaskStore = create<TaskStore>()(createTaskStore)

function createTaskStore(
  set: Parameters<StateCreator<TaskStore>>[0],
  get: Parameters<StateCreator<TaskStore>>[1]
): TaskStore {
  /** 拉取某个会话下的任务列表。 */
  async function loadSessionTasks(sessionId: string): Promise<void> {
    set({ sessionTasksLoading: true, error: null })
    try {
      const tasks = await fetchSessionTasks(sessionId)
      set({ sessionTasks: tasks })
    } catch (e) {
      set({ error: extractErrorMessage(e) })
    } finally {
      set({ sessionTasksLoading: false })
    }
  }

  /** 拉取任务列表：带游标时追加，否则整体替换；正在加载时跳过。 */
  async function loadTasks(cursor?: string): Promise<void> {
    const { tasksLoading } = get()
    if (tasksLoading) return
    set({ tasksLoading: true, error: null })
    try {
      const data = await fetchTasks(cursor)
      set((state) => ({
        tasks: cursor ? [...state.tasks, ...data.tasks] : data.tasks,
        tasksNextCursor: data.next_cursor || null,
      }))
    } catch (e) {
      set({ error: extractErrorMessage(e) })
    } finally {
      set({ tasksLoading: false })
    }
  }

  /** 拉取任务详情；响应回来时若已有更新的请求，则整条结果丢弃。 */
  async function loadTaskDetail(taskId: string): Promise<void> {
    const requestSerial = ++taskDetailRequestSerial
    set({ currentTask: null, currentTaskLoading: true, error: null })
    try {
      const task = await fetchTask(taskId)
      if (requestSerial !== taskDetailRequestSerial) return
      set({ currentTask: task })
    } catch (e) {
      if (requestSerial === taskDetailRequestSerial) {
        set({ currentTask: null, error: extractErrorMessage(e) })
      }
    } finally {
      if (requestSerial === taskDetailRequestSerial) {
        set({ currentTaskLoading: false })
      }
    }
  }

  /** 拉取某任务的执行列表；首屏先清空旧列表，响应回来时丢弃过期请求。 */
  async function loadExecutions(taskId: string, cursor?: string): Promise<void> {
    const requestSerial = ++executionListRequestSerial
    set({
      ...(cursor ? {} : { executions: [], executionsNextCursor: null }),
      executionsLoading: true,
      error: null,
    })
    try {
      const data = await fetchExecutions(taskId, cursor)
      if (requestSerial !== executionListRequestSerial) return
      set((state) => ({
        executions: cursor ? [...state.executions, ...data.executions] : data.executions,
        executionsNextCursor: data.next_cursor || null,
      }))
    } catch (e) {
      if (requestSerial === executionListRequestSerial) {
        set({ error: extractErrorMessage(e) })
      }
    } finally {
      if (requestSerial === executionListRequestSerial) {
        set({ executionsLoading: false })
      }
    }
  }

  /** 拉取执行详情；响应回来时若已有更新的请求，则整条结果丢弃。 */
  async function loadExecutionDetail(taskId: string, executionId: string): Promise<void> {
    const requestSerial = ++executionDetailRequestSerial
    set({ activeExecution: null, activeExecutionLoading: true, error: null })
    try {
      const execution = await fetchExecution(taskId, executionId)
      if (requestSerial !== executionDetailRequestSerial) return
      set({ activeExecution: execution })
    } catch (e) {
      if (requestSerial === executionDetailRequestSerial) {
        set({ activeExecution: null, error: extractErrorMessage(e) })
      }
    } finally {
      if (requestSerial === executionDetailRequestSerial) {
        set({ activeExecutionLoading: false })
      }
    }
  }

  /** 批量补拉执行视图状态（未加载或加载失败的），失败重试两次后退化为默认态。 */
  async function loadExecutionViewStates(executionIds: string[]): Promise<void> {
    const uniqueIDs = [...new Set(executionIds)].filter(Boolean)
    const current = get()
    const missingIDs = uniqueIDs.filter(
      (id) =>
        (!current.executionViewStatesLoaded[id] || current.executionViewStatesFailed[id]) &&
        !current.executionViewStatesLoading[id]
    )
    if (missingIDs.length === 0) return

    set((state) => ({
      executionViewStatesLoading: {
        ...state.executionViewStatesLoading,
        ...Object.fromEntries(missingIDs.map((id) => [id, true])),
      },
    }))

    try {
      let states: ExecutionViewState[] | null = null
      for (let attempt = 0; attempt < 3 && states === null; attempt += 1) {
        try {
          const loaded: ExecutionViewState[] = []
          for (let start = 0; start < missingIDs.length; start += 100) {
            loaded.push(...(await fetchExecutionViewStates(missingIDs.slice(start, start + 100))))
          }
          states = loaded
        } catch (error) {
          const retryable = !(error instanceof AppError) || error.status >= 500
          if (!retryable || attempt === 2) throw error
          await retryDelay(attempt)
        }
      }
      if (!states) return
      const returned = new Map(states.map((state) => [state.execution_id, state]))
      set((current) => withLoadedViewStates(current, missingIDs, returned))
    } catch {
      // 三次读取仍失败时退化为默认状态，不能让正文永久空白；后续 PUT 仍可恢复持久化。
      set((current) => ({
        executionViewStates: {
          ...current.executionViewStates,
          ...Object.fromEntries(
            missingIDs.map((id) => [id, current.executionViewStates[id] ?? EMPTY_VIEW_STATE(id)])
          ),
        },
        executionViewStatesLoaded: {
          ...current.executionViewStatesLoaded,
          ...Object.fromEntries(missingIDs.map((id) => [id, true])),
        },
        executionViewStatesLoading: {
          ...current.executionViewStatesLoading,
          ...Object.fromEntries(missingIDs.map((id) => [id, false])),
        },
        executionViewStatesFailed: {
          ...current.executionViewStatesFailed,
          ...Object.fromEntries(missingIDs.map((id) => [id, true])),
        },
      }))
    }
  }

  /** 标记执行已读；已读过则直接返回成功，否则写服务端并以回执落状态。 */
  async function markExecutionSeen(taskId: string, executionId: string): Promise<boolean> {
    const previous = get().executionViewStates[executionId] ?? EMPTY_VIEW_STATE(executionId)
    if (previous.seen_at) return true
    try {
      const saved = await updateExecutionViewState(taskId, executionId, { mark_seen: true })
      set((current) => ({
        executionViewStates: {
          ...current.executionViewStates,
          [executionId]: {
            ...(current.executionViewStates[executionId] ?? previous),
            seen_at: saved.seen_at,
            updated_at: laterTimestamp(
              current.executionViewStates[executionId]?.updated_at ?? null,
              saved.updated_at
            ),
          },
        },
        executionViewStatesLoaded: {
          ...current.executionViewStatesLoaded,
          [executionId]: true,
        },
        executionViewStatesFailed: {
          ...current.executionViewStatesFailed,
          [executionId]: false,
        },
      }))
      return true
    } catch {
      return false
    }
  }

  /** 设置执行折叠态：先乐观写入，服务端回执或失败后各自回填。 */
  async function setExecutionCollapsed(
    taskId: string,
    executionId: string,
    collapsed: boolean
  ): Promise<boolean> {
    const previous = get().executionViewStates[executionId] ?? EMPTY_VIEW_STATE(executionId)
    set((current) => ({
      executionViewStates: {
        ...current.executionViewStates,
        [executionId]: { ...previous, collapsed_override: collapsed },
      },
      executionViewStatesLoaded: {
        ...current.executionViewStatesLoaded,
        [executionId]: true,
      },
      executionViewStatesFailed: {
        ...current.executionViewStatesFailed,
        [executionId]: false,
      },
    }))
    try {
      const saved = await updateExecutionViewState(taskId, executionId, {
        collapsed_override: collapsed,
      })
      set((current) => ({
        executionViewStates: {
          ...current.executionViewStates,
          [executionId]: {
            ...(current.executionViewStates[executionId] ?? previous),
            collapsed_override: saved.collapsed_override,
            updated_at: laterTimestamp(
              current.executionViewStates[executionId]?.updated_at ?? null,
              saved.updated_at
            ),
          },
        },
      }))
      return true
    } catch {
      set((current) => ({
        executionViewStates: {
          ...current.executionViewStates,
          [executionId]: {
            ...(current.executionViewStates[executionId] ?? previous),
            collapsed_override: previous.collapsed_override,
          },
        },
      }))
      return false
    }
  }

  /** 切换任务启用态，并把新状态同步到详情与各列表项。 */
  async function toggleTaskActive(taskId: string): Promise<void> {
    const task = get().currentTask
    if (!task) return
    set({ error: null })
    try {
      const newActive = !task.IsActive
      await updateTask(taskId, newActive)
      set({
        currentTask: { ...task, IsActive: newActive },
        sessionTasks: get().sessionTasks.map((t) =>
          t.TaskID === taskId ? { ...t, IsActive: newActive } : t
        ),
        tasks: get().tasks.map((t) => (t.TaskID === taskId ? { ...t, IsActive: newActive } : t)),
      })
    } catch (e) {
      set({ error: extractErrorMessage(e) })
    }
  }

  /** 删除任务，并从会话任务列表与任务列表中一并移除。 */
  async function deleteTask(taskId: string): Promise<void> {
    set({ error: null })
    try {
      await deleteTaskApi(taskId)
      set((state) => ({
        sessionTasks: state.sessionTasks.filter((t) => t.TaskID !== taskId),
        tasks: state.tasks.filter((t) => t.TaskID !== taskId),
        currentTask: null,
      }))
    } catch (e) {
      set({ error: extractErrorMessage(e) })
    }
  }

  return {
    ...initialState,

    loadSessionTasks,
    loadTasks,
    loadTaskDetail,
    loadExecutions,
    loadExecutionDetail,
    loadExecutionViewStates,
    markExecutionSeen,
    setExecutionCollapsed,
    toggleTaskActive,
    deleteTask,

    reset: () => set(initialState),
  }
}

/* store 一律不做热替换：React Fast Refresh 只重建"接受更新"的组件边界，没被重建的模块
   （如 useChatStream）会继续持有旧 store 实例，于是写入方与读取方各绑一份 state——
   表现就是实时投影不再跟随 SSE、流结束后同一轮出现两次。这里声明自接受并整页刷新，
   代价是开发期一次刷新，换来实例唯一（import.meta.hot 在生产构建中为 undefined）。 */
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}
