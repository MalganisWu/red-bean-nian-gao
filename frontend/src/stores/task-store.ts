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

/**
 * 任务 store 的只读状态切片：会话任务、任务列表、当前任务详情、执行列表与执行视图状态索引，
 * 每类异步资源各带 loading 标志，`error` 记录最近一次失败消息（三态语义见各 action）。
 */
interface TaskState {
  /** 某个会话下的任务列表。 */
  sessionTasks: TaskListItem[]
  /** 会话任务列表是否正在加载。 */
  sessionTasksLoading: boolean
  /** 全局任务列表（分页累积）。 */
  tasks: TaskListItem[]
  /** 全局任务列表是否正在加载。 */
  tasksLoading: boolean
  /** 任务列表下一页游标；null 表示已到末页。 */
  tasksNextCursor: string | null
  /** 当前查看的任务详情；未加载时为 null。 */
  currentTask: Task | null
  /** 任务详情是否正在加载。 */
  currentTaskLoading: boolean
  /** 某任务的执行列表（分页累积）。 */
  executions: TaskExecution[]
  /** 执行列表是否正在加载。 */
  executionsLoading: boolean
  /** 执行列表下一页游标；null 表示已到末页。 */
  executionsNextCursor: string | null
  /** 当前查看的执行详情；未加载时为 null。 */
  activeExecution: TaskExecution | null
  /** 执行详情是否正在加载。 */
  activeExecutionLoading: boolean
  /** 各执行的视图状态索引（已读、折叠覆盖等），按执行 ID 建键。 */
  executionViewStates: Record<string, ExecutionViewState>
  /** 各执行视图状态是否已加载过；用于判断是否需要补拉。 */
  executionViewStatesLoaded: Record<string, boolean>
  /** 各执行视图状态是否正在拉取中；用于去重并发请求。 */
  executionViewStatesLoading: Record<string, boolean>
  /** 各执行视图状态是否拉取失败；失败的条目允许后续重试。 */
  executionViewStatesFailed: Record<string, boolean>
  /** 最近一次请求失败的错误消息（三态 error 态） */
  error: string | null
}

/**
 * 任务 store 的写动作集合；每个异步 action 自行管理 loading 与 error，
 * 拉取类用自增序号丢弃过期响应，变更类做乐观更新并在失败时回滚。
 */
interface TaskActions {
  /**
   * 拉取某个会话下的任务列表（覆盖式）。
   *
   * @param sessionId - 目标会话主键；用于定位并覆盖该会话下的任务列表。
   */
  loadSessionTasks: (sessionId: string) => Promise<void>
  /**
   * 拉取任务列表：带游标时追加，否则整体替换；正在加载时跳过。
   *
   * @param cursor - 上一页返回的翻页游标；缺省表示拉取首页并整体替换列表。
   */
  loadTasks: (cursor?: string) => Promise<void>
  /**
   * 拉取任务详情；响应回来时若已有更新的请求，则整条结果丢弃。
   *
   * @param taskId - 目标任务主键；用于定位并把结果写入当前任务详情。
   */
  loadTaskDetail: (taskId: string) => Promise<void>
  /**
   * 拉取某任务的执行列表；首屏先清空旧列表，响应回来时丢弃过期请求。
   *
   * @param taskId - 所属任务主键；用于定位任务下的执行集合并限定请求范围。
   * @param cursor - 上一页返回的翻页游标；缺省表示拉取首页并清空旧列表。
   */
  loadExecutions: (taskId: string, cursor?: string) => Promise<void>
  /**
   * 拉取执行详情；响应回来时若已有更新的请求，则整条结果丢弃。
   *
   * @param taskId - 所属任务主键；用于限定执行归属并构造请求路径。
   * @param executionId - 目标执行主键；用于定位并把结果写入当前执行详情。
   */
  loadExecutionDetail: (taskId: string, executionId: string) => Promise<void>
  /**
   * 批量补拉执行视图状态（未加载或加载失败的），失败重试两次后退化为默认态。
   *
   * @param executionIds - 待补拉的执行主键集合；内部去重并跳过已加载或在途的条目。
   */
  loadExecutionViewStates: (executionIds: string[]) => Promise<void>
  /**
   * 标记执行已读；已读过则直接返回成功，否则写服务端并以回执落状态。
   *
   * @param taskId - 所属任务主键；用于限定执行归属并构造请求路径。
   * @param executionId - 目标执行主键；用于定位待标记的视图状态。
   * @returns 是否已成功置为已读；已读过或写入成功返回 true，写入失败返回 false。
   */
  markExecutionSeen: (taskId: string, executionId: string) => Promise<boolean>
  /**
   * 设置执行折叠态：先乐观写入，服务端回执或失败后各自回填。
   *
   * @param taskId - 所属任务主键；用于限定执行归属并构造请求路径。
   * @param executionId - 目标执行主键；用于定位待折叠的视图状态。
   * @param collapsed - 目标折叠状态；true 收起、false 展开。
   * @returns 服务端写入是否成功；失败时已回滚本地乐观更新并返回 false。
   */
  setExecutionCollapsed: (
    taskId: string,
    executionId: string,
    collapsed: boolean
  ) => Promise<boolean>
  /**
   * 切换任务启用态，并把新状态同步到详情与各列表项。
   *
   * @param taskId - 目标任务主键；无当前任务详情时直接跳过。
   */
  toggleTaskActive: (taskId: string) => Promise<void>
  /**
   * 删除任务，并从会话任务列表与全局任务列表中一并移除。
   *
   * @param taskId - 目标任务主键；用于删除服务端记录并清理各列表项。
   */
  deleteTask: (taskId: string) => Promise<void>
  /** 复位任务 store 到初始状态。 */
  reset: () => void
}

/** store 初始状态：空列表、未加载、无错误，作为首次装载与 `reset` 的基线。 */
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

/**
 * 构造某执行的默认视图状态：未见、无折叠覆盖、无更新时间；批量拉取缺失时用它占位，
 * 保证渲染层拿到的字段齐备而不是 undefined。
 *
 * @param executionId - 该视图状态所属的执行 ID。
 * @returns 字段齐全的默认视图状态。
 */
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
 *
 * @param current - 应用补丁前的 store 快照。
 * @param missingIDs - 本次批量拉取覆盖的执行 ID 集合。
 * @param returned - 服务端返回的视图状态，按执行 ID 建索引。
 * @returns 只改动目标条目的局部状态补丁。
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

/**
 * 取两个 ISO 时间戳中较晚的一个，任一为空时回退到另一个；用于合并本地与服务端的
 * `updated_at`，避免迟到的旧回执把时间戳改小。
 *
 * @param current - 本地已有的时间戳，可为 null。
 * @param incoming - 新到达的时间戳，可为 null。
 * @returns 两者中较晚的时间戳；都为空时返回 null。
 */
function laterTimestamp(current: string | null, incoming: string | null): string | null {
  if (!current) return incoming
  if (!incoming) return current
  return incoming > current ? incoming : current
}

/**
 * 视图状态补拉失败后的退避等待：第 attempt 次重试前等待 `250 * 2^attempt` 毫秒，
 * 用于对 5xx 与网络抖动做有限次重试。
 *
 * @param attempt - 从 0 开始的重试次数，决定退避时长。
 */
const retryDelay = (attempt: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, 250 * 2 ** attempt))

/** 执行详情请求的自增序号；响应回来时与当前值比对，不等则丢弃过期结果。 */
let executionDetailRequestSerial = 0
/** 任务详情请求的自增序号；响应回来时与当前值比对，不等则丢弃过期结果。 */
let taskDetailRequestSerial = 0
/** 执行列表请求的自增序号；用于丢弃翻页竞态下过期的列表响应。 */
let executionListRequestSerial = 0

/** store 完整形态：状态切片与写动作的并集。 */
type TaskStore = TaskState & TaskActions

/** 任务 store：会话内任务、任务详情与执行列表；每类请求带自增序号，用于丢弃过期响应。 */
export const useTaskStore = create<TaskStore>()(createTaskStore)

/**
 * 构造任务 store：把状态切片与各 action 组装为 zustand 的 StateCreator。
 * 拉取类 action 以自增序号丢弃过期响应，变更类 action 采用乐观更新加失败回滚。
 *
 * @param set - zustand 的写状态函数，支持局部补丁与函数式更新。
 * @param get - 读取当前状态的函数，用于去重判断与乐观更新前的快照。
 * @returns 供 `create` 使用的完整 store 定义。
 */
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
