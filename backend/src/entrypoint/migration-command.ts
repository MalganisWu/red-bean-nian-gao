import type { MigrationRunnerPort } from '../infra/database/migrator.js'

/** migrate CLI 的三个子命令。 */
export type MigrationCommand = 'up' | 'down' | 'status'

/**
 * 解析子命令；缺省是 `up`，未知值直接抛错并给出用法——拼错一个字母就默默跑 up 太危险。
 * @param value - 命令行首个子命令；`undefined`（未给出）视为 `up`，空串不算未给出而是未知命令
 * @returns 已识别的子命令；任何未被识别的取值都不返回，直接抛错
 */
export function parseMigrationCommand(value: string | undefined): MigrationCommand {
  const command = value ?? 'up'
  if (command === 'up' || command === 'down' || command === 'status') return command
  throw new Error(`未知命令: ${command}\n用法: migrate [up|down|status]`)
}

/**
 * 执行一次 migrate CLI 调用，并把结果写成给人读的行。
 *
 * 本函数只负责「调端口 + 排版输出」，不自己做迁移决策：`up` / `down` / `status` 的语义、
 * 事务边界与历史校验都由 `migrator` 承担，失败时它的异常原样向上抛，
 * 让 CLI 以非零退出码收场——迁移失败绝不能伪装成成功。
 * @param command - 已解析的子命令，取值只可能是 `up` / `down` / `status`
 * @param migrator - 迁移端口；本函数不关心它是真实实现还是测试替身
 * @param signal - 取消信号，透传给迁移端口
 * @param writeLine - 输出回调；注入它是为了测试能直接断言文本而不必抓 stdout
 */
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
