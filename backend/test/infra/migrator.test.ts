import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { MIGRATIONS, PostgresMigrator } from '../../src/infra/database/migrator.js'
import type {
  SqlExecutor,
  SqlQueryResult,
  TransactionalSqlExecutor,
} from '../../src/infra/database/postgres.js'

interface RecordedQuery {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

class MigrationDatabase implements TransactionalSqlExecutor {
  public readonly queries: RecordedQuery[] = []
  public historyRows: readonly unknown[] = []
  public transactions = 0
  public failWhenSqlIncludes = ''

  public query(
    sql: string,
    parameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<SqlQueryResult> {
    signal.throwIfAborted()
    this.queries.push({ sql, parameters })
    if (this.failWhenSqlIncludes !== '' && sql.includes(this.failWhenSqlIncludes)) {
      return Promise.reject(new Error('migration statement failed'))
    }
    if (sql.includes('FROM bun_migrations')) {
      return Promise.resolve({ rows: this.historyRows, rowCount: this.historyRows.length })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
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

const migrationNames = [
  '20260604000001',
  '20260605000001',
  '20260607000001',
  '20260608000001',
  '20260609000001',
  '20260727000001',
  '20260731000001',
  '20260803000001',
  '20260811000001',
  '20260828000001',
  '20260828000002',
  '20260831000001',
  '20260907000001',
  '20260908000001',
  '20260908000002',
  '20260908000003',
  '20260911000001',
]

void describe('Bun-compatible TypeScript migrator', () => {
  void it('registers the frozen migrations in the original order', () => {
    assert.deepEqual(
      MIGRATIONS.map((migration): string => migration.name),
      migrationNames
    )
    assert.ok(MIGRATIONS.every((migration): boolean => migration.up.length > 0))
    assert.ok(MIGRATIONS.every((migration): boolean => migration.down.length > 0))
  })

  void it('initializes Bun history tables and applies every pending migration as one group', async () => {
    const database = new MigrationDatabase()
    const migrator = new PostgresMigrator(database)

    const group = await migrator.up(AbortSignal.timeout(1_000))

    assert.deepEqual(group, { groupId: 1, migrationNames })
    assert.equal(database.transactions, 1)
    assert.ok(database.queries.some((query): boolean => query.sql.includes('bun_migrations')))
    assert.ok(database.queries.some((query): boolean => query.sql.includes('bun_migration_locks')))
    const historyWrites = database.queries.filter((query): boolean =>
      query.sql.includes('INSERT INTO bun_migrations')
    )
    assert.equal(historyWrites.length, migrationNames.length)
    assert.deepEqual(
      historyWrites.map((query): unknown => query.parameters),
      migrationNames.map((name): readonly unknown[] => [name, 1])
    )
  })

  void it('recognizes an existing Bun history without replaying migrations', async () => {
    const database = new MigrationDatabase()
    database.historyRows = migrationNames.map((name, index): unknown => ({
      id: String(index + 1),
      name,
      group_id: '1',
      migrated_at: new Date('2026-09-04T00:00:00.000Z'),
    }))
    const migrator = new PostgresMigrator(database)

    const group = await migrator.up(AbortSignal.timeout(1_000))
    const status = await migrator.status(AbortSignal.timeout(1_000))

    assert.deepEqual(group, { groupId: 0, migrationNames: [] })
    assert.equal(database.transactions, 1)
    assert.ok(status.every((migration): boolean => migration.status === 'applied'))
    assert.equal(
      database.queries.filter((query): boolean => query.sql.includes('INSERT INTO bun_migrations'))
        .length,
      0
    )
  })

  void it('rejects unknown, duplicate and non-prefix Bun histories', async () => {
    for (const historyRows of [
      [historyRow('20990101000000', 1, 1)],
      [historyRow(migrationNames[0] ?? '', 1, 1), historyRow(migrationNames[0] ?? '', 2, 1)],
      [historyRow(migrationNames[1] ?? '', 1, 1)],
    ]) {
      const database = new MigrationDatabase()
      database.historyRows = historyRows
      const migrator = new PostgresMigrator(database)
      await assert.rejects(migrator.status(AbortSignal.timeout(1_000)), /migration history/u)
    }
  })

  void it('rolls back only the latest Bun migration group in reverse order', async () => {
    const database = new MigrationDatabase()
    database.historyRows = migrationNames.map((name, index): unknown =>
      historyRow(name, index + 1, index < 10 ? 1 : 2)
    )
    const migrator = new PostgresMigrator(database)

    const group = await migrator.down(AbortSignal.timeout(1_000))

    assert.deepEqual(group, {
      groupId: 2,
      migrationNames: [
        '20260911000001',
        '20260908000003',
        '20260908000002',
        '20260908000001',
        '20260907000001',
        '20260831000001',
        '20260828000002',
      ],
    })
    const deletes = database.queries.filter((query): boolean =>
      query.sql.includes('DELETE FROM bun_migrations')
    )
    assert.deepEqual(
      deletes.map((query): unknown => query.parameters),
      [
        ['20260911000001'],
        ['20260908000003'],
        ['20260908000002'],
        ['20260908000001'],
        ['20260907000001'],
        ['20260831000001'],
        ['20260828000002'],
      ]
    )
  })

  void it('reports migration context when an up statement fails', async () => {
    const database = new MigrationDatabase()
    database.failWhenSqlIncludes = 'CREATE TABLE IF NOT EXISTS users'
    const migrator = new PostgresMigrator(database)

    await assert.rejects(
      migrator.up(AbortSignal.timeout(1_000)),
      /migration 20260608000001 up failed: migration statement failed/u
    )
  })

  void it('returns pending status for the unapplied suffix', async () => {
    const database = new MigrationDatabase()
    database.historyRows = [historyRow(migrationNames[0] ?? '', 1, 7)]
    const migrator = new PostgresMigrator(database)

    const status = await migrator.status(AbortSignal.timeout(1_000))

    assert.equal(status[0]?.status, 'applied')
    assert.equal(status[0]?.groupId, 7)
    assert.ok(status.slice(1).every((migration): boolean => migration.status === 'pending'))
  })
})

function historyRow(name: string, id: number, groupId: number): unknown {
  return {
    id: String(id),
    name,
    group_id: String(groupId),
    migrated_at: new Date('2026-09-04T00:00:00.000Z'),
  }
}
