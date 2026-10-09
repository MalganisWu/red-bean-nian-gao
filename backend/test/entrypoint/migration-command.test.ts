import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  executeMigrationCommand,
  parseMigrationCommand,
} from '../../src/entrypoint/migration-command.js'
import type {
  MigrationGroup,
  MigrationRunnerPort,
  MigrationStatus,
} from '../../src/infra/database/migrator.js'

class RecordingMigrationRunner implements MigrationRunnerPort {
  public upResult: MigrationGroup = { groupId: 0, migrationNames: [] }
  public downResult: MigrationGroup = { groupId: 0, migrationNames: [] }
  public statusResult: readonly MigrationStatus[] = []
  public calls: string[] = []

  public up(signal: AbortSignal): Promise<MigrationGroup> {
    signal.throwIfAborted()
    this.calls.push('up')
    return Promise.resolve(this.upResult)
  }

  public down(signal: AbortSignal): Promise<MigrationGroup> {
    signal.throwIfAborted()
    this.calls.push('down')
    return Promise.resolve(this.downResult)
  }

  public status(signal: AbortSignal): Promise<readonly MigrationStatus[]> {
    signal.throwIfAborted()
    this.calls.push('status')
    return Promise.resolve(this.statusResult)
  }
}

void describe('TypeScript migration command', () => {
  void it('accepts only up, down and status while defaulting to up', () => {
    assert.equal(parseMigrationCommand(undefined), 'up')
    assert.equal(parseMigrationCommand('up'), 'up')
    assert.equal(parseMigrationCommand('down'), 'down')
    assert.equal(parseMigrationCommand('status'), 'status')
    assert.throws(() => parseMigrationCommand('redo'), /未知命令: redo/u)
  })

  void it('prints stable up and down outcomes', async () => {
    const runner = new RecordingMigrationRunner()
    const output: string[] = []
    const writeLine = (line: string): void => {
      output.push(line)
    }
    const signal = AbortSignal.timeout(1_000)

    await executeMigrationCommand('up', runner, signal, writeLine)
    await executeMigrationCommand('down', runner, signal, writeLine)
    assert.deepEqual(output, ['已是最新，无需迁移', '没有可回滚的迁移'])

    runner.upResult = { groupId: 3, migrationNames: ['20260604000001', '20260605000001'] }
    runner.downResult = { groupId: 3, migrationNames: ['20260605000001'] }
    await executeMigrationCommand('up', runner, signal, writeLine)
    await executeMigrationCommand('down', runner, signal, writeLine)
    assert.equal(output[2], '迁移完成: group=3 migrations=20260604000001,20260605000001')
    assert.equal(output[3], '已回滚: group=3 migrations=20260605000001')
  })

  void it('prints every migration status in catalog order', async () => {
    const runner = new RecordingMigrationRunner()
    runner.statusResult = [
      { name: '20260604000001', comment: 'initial_schema', status: 'applied', groupId: 1 },
      { name: '20260605000001', comment: 'sub_agent_executions', status: 'pending' },
    ]
    const output: string[] = []

    await executeMigrationCommand(
      'status',
      runner,
      AbortSignal.timeout(1_000),
      (line: string): void => {
        output.push(line)
      }
    )

    assert.deepEqual(runner.calls, ['status'])
    assert.equal(output.length, 2)
    assert.match(output[0] ?? '', /^20260604000001_initial_schema\s+applied$/u)
    assert.match(output[1] ?? '', /^20260605000001_sub_agent_executions\s+pending$/u)
  })
})
