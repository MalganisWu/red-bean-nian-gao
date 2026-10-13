import { buildApplication } from '../app/composition-root.js'
import { loadConfig } from '../infra/config/config.js'
import { loadLocalEnvFile } from '../infra/config/load-local-env-file.js'

/** 进程级中止信号源：收到 SIGINT/SIGTERM 后中止，驱动应用走优雅关停路径。 */
const processController = new AbortController()

/**
 * 收到关停信号时的统一处理：仅在尚未中止时触发中止，避免重复关停打断正在进行的收尾。
 *
 * @param signalName 触发关停的信号名，写入中止原因便于排查
 */
function stop(signalName: string): void {
  if (!processController.signal.aborted) {
    processController.abort(new Error(`received ${signalName}`))
  }
}

/** SIGINT 监听器：把 Ctrl+C 归一成统一关停流程。 */
const onInterrupt = (): void => stop('SIGINT')
/** SIGTERM 监听器：把容器/进程管理器的终止信号归一成统一关停流程。 */
const onTerminate = (): void => stop('SIGTERM')
process.once('SIGINT', onInterrupt)
process.once('SIGTERM', onTerminate)

try {
  /* 本地单源：先把 backend/.env.local 注入 process.env（不覆盖已存在的变量），再解析配置 */
  loadLocalEnvFile(process.cwd())
  const config = await loadConfig()
  const application = await buildApplication(config, processController.signal, {
    version: {
      version: process.env['APP_VERSION'] ?? 'dev',
      commit: process.env['GIT_COMMIT'] ?? 'unknown',
      builtAt: process.env['BUILD_TIME'] ?? 'unknown',
    },
  })
  await application.run(processController.signal)
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`服务运行失败: ${message}\n`)
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', onInterrupt)
  process.removeListener('SIGTERM', onTerminate)
}
