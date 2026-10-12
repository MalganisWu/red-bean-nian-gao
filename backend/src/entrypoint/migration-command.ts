import type { MigrationRunnerPort } from '../infra/database/migrator.js'

/** migrate CLI 的三个子命令。 */
export type MigrationCommand = 'up' | 'down' | 'status'

/** 解析子命令；缺省是 `up`，未知值直接抛错并给出用法——拼错一个字母就默默跑 up 太危险。 */
export function parseMigrationCommand(value: string | undefined): MigrationCommand {
  const command = value ?? 'up'
  if (command === 'up' || command === 'down' || command === 'status') return command
  throw new Error(`未知命令: ${command}\n用法: migrate [up|down|status]`)
}

export async function executeMigrationCommand(
  command: MigrationCommand,
  migrator: MigrationRunnerPort,
  signal: AbortSignal,
  writeLine: (line: string) => void
): Promise<void> {
  if (command === 'status') {
    const migrations = await migrator.status(signal)
    for (const migration of migrations) {
      writeLine(`${migration.name}_${migration.comment}`.padEnd(40) + ` ${migration.status}`)
    }
    return
  }

  const group = command === 'up' ? await migrator.up(signal) : await migrator.down(signal)
  if (group.migrationNames.length === 0) {
    writeLine(command === 'up' ? '已是最新，无需迁移' : '没有可回滚的迁移')
    return
  }

  const summary = `group=${String(group.groupId)} migrations=${group.migrationNames.join(',')}`
  writeLine(command === 'up' ? `迁移完成: ${summary}` : `已回滚: ${summary}`)
}
