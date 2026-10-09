/** 由应用生命周期启动并通过 AbortSignal 停止的后台任务。 */
export type BackgroundTask = (signal: AbortSignal) => Promise<void>
