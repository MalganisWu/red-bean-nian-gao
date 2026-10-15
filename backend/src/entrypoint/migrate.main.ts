import { executeMigrationCommand, parseMigrationCommand } from './migration-command.js'
import { loadConfig } from '../infra/config/config.js'
import { loadLocalEnvFile } from '../infra/config/load-local-env-file.js'
import { PostgresMigrator } from '../infra/database/migrator.js'
import { connectPostgres } from '../infra/database/postgres.js'

/** 迁移入口与进程信号共用的中止信号：收到 SIGINT/SIGTERM 后，等待中的连接与语句一并中止。 */
const abortController = new AbortController()

/** SIGINT/SIGTERM 的中止回调：带原因中止信号，让进行中的迁移能读到中断原因并干净退出。 */
function abort(): void {
  abortController.abort(new Error('migration 已中断'))
}

process.once('SIGINT', abort)
process.once('SIGTERM', abort)

try {
  const command = parseMigrationCommand(process.argv[2])
  // 与 server.main 同源：本地配置只写在 backend/.env.local，入口处统一注入
  loadLocalEnvFile(process.cwd())
  const config = await loadConfig()
  const database = await connectPostgres(config.database.url, abortController.signal)
  try {
    await executeMigrationCommand(
      command,
      new PostgresMigrator(database),
      abortController.signal,
      (line: string): void => {
        process.stdout.write(`${line}\n`)
      }
    )
  } finally {
    await database.close()
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`迁移失败: ${message}\n`)
  process.exitCode = 1
} finally {
  process.removeListener('SIGINT', abort)
  process.removeListener('SIGTERM', abort)
}
