import { buildApplication } from '../app/composition-root.js'
import { loadConfig } from '../infra/config/config.js'
import { loadLocalEnvFile } from '../infra/config/load-local-env-file.js'

const processController = new AbortController()

function stop(signalName: string): void {
  if (!processController.signal.aborted) {
    processController.abort(new Error(`received ${signalName}`))
  }
}

const onInterrupt = (): void => stop('SIGINT')
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
