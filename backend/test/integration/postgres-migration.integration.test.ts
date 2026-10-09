import assert from 'node:assert/strict'
import { it } from 'node:test'
import { MIGRATIONS, PostgresMigrator } from '../../src/infra/database/migrator.js'
import { connectPostgres, type PostgresDatabase } from '../../src/infra/database/postgres.js'
import { PostgresSubExecutionRepository } from '../../src/modules/agent/subagent/repository/adapter/postgres-sub-execution-repository.js'
import {
  REQUIRED_ENVIRONMENT,
  DATABASE_URL_ENVIRONMENT,
  COMPOSE_ENV_FILE_ENVIRONMENT,
  loadIntegrationDatabaseUrl,
  databaseName,
  withDatabase,
  quoteIdentifier,
} from './integration-environment-test-support.js'
import {
  EXPECTED_TABLES,
  verifyUserRoundTrip,
  verifyTaskRoundTrip,
  verifySessionRunRoundTrip,
  publicTables,
  sessionFencingColumns,
  subExecutionRevisionColumns,
  subExecutionConcurrencyColumns,
  integrationSubExecution,
} from './postgres-persistence-test-support.js'

void it('runs TypeScript migrations and user persistence against real PostgreSQL', async (test) => {
  const databaseUrl = await loadIntegrationDatabaseUrl()
  if (databaseUrl === undefined) {
    const message = `${DATABASE_URL_ENVIRONMENT} 或 ${COMPOSE_ENV_FILE_ENVIRONMENT} 未设置`
    if (process.env[REQUIRED_ENVIRONMENT] === '1') throw new Error(message)
    test.skip(`${message}，跳过集成测试`)
    return
  }

  const signal = AbortSignal.timeout(60_000)
  const adminUrl = withDatabase(databaseUrl, databaseName(databaseUrl))
  const admin = await connectPostgres(adminUrl, signal)
  const temporaryDatabaseName = `rbng_ts_${String(process.pid)}_${String(Date.now())}`
  const temporaryUrl = withDatabase(databaseUrl, temporaryDatabaseName)
  let database: PostgresDatabase | undefined
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(temporaryDatabaseName)}`, [], signal)
    database = await connectPostgres(temporaryUrl, signal)
    const migrator = new PostgresMigrator(database)

    const firstGroup = await migrator.up(signal)
    assert.equal(firstGroup.migrationNames.length, MIGRATIONS.length)
    assert.deepEqual(await publicTables(database, signal), EXPECTED_TABLES)
    assert.deepEqual(await sessionFencingColumns(database, signal), ['fencing_token', 'revision'])
    assert.deepEqual(await subExecutionRevisionColumns(database, signal), [
      'recovery_messages',
      'revision',
    ])
    assert.ok((await migrator.status(signal)).every((item): boolean => item.status === 'applied'))
    assert.deepEqual(await migrator.up(signal), { groupId: 0, migrationNames: [] })

    await verifyUserRoundTrip(database, signal)
    await verifyTaskRoundTrip(database, signal)
    await verifySessionRunRoundTrip(database, signal)

    const rollback = await migrator.down(signal)
    assert.equal(rollback.migrationNames.length, MIGRATIONS.length)
    assert.ok((await migrator.status(signal)).every((item): boolean => item.status === 'pending'))
    assert.equal((await migrator.up(signal)).migrationNames.length, MIGRATIONS.length)
    assert.deepEqual(await publicTables(database, signal), EXPECTED_TABLES)
  } finally {
    if (database !== undefined) await database.close()
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(temporaryDatabaseName)} WITH (FORCE)`,
      [],
      signal
    )
    await admin.close()
  }
})

void it('repairs a database whose recorded sub execution migration lacks recovery WAL', async (test) => {
  const databaseUrl = await loadIntegrationDatabaseUrl()
  if (databaseUrl === undefined) {
    const message = `${DATABASE_URL_ENVIRONMENT} 或 ${COMPOSE_ENV_FILE_ENVIRONMENT} 未设置`
    if (process.env[REQUIRED_ENVIRONMENT] === '1') throw new Error(message)
    test.skip(`${message}，跳过旧库升级集成测试`)
    return
  }

  const signal = AbortSignal.timeout(60_000)
  const adminUrl = withDatabase(databaseUrl, databaseName(databaseUrl))
  const admin = await connectPostgres(adminUrl, signal)
  const temporaryDatabaseName = `rbng_upgrade_${String(process.pid)}_${String(Date.now())}`
  const temporaryUrl = withDatabase(databaseUrl, temporaryDatabaseName)
  let database: PostgresDatabase | undefined
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(temporaryDatabaseName)}`, [], signal)
    database = await connectPostgres(temporaryUrl, signal)
    const repairMigrationName = '20260908000003'
    // 模拟已记录到 00002（含旧修复语义）的真实数据库：只应用 00003 之前的目录建库。
    const repairIndex = MIGRATIONS.findIndex(
      (migration): boolean => migration.name === repairMigrationName
    )
    await new PostgresMigrator(database, MIGRATIONS.slice(0, repairIndex)).up(signal)
    // 模拟已经记录旧版 00002、但当时尚未包含 recovery_messages 的真实数据库。
    await database.query(
      'ALTER TABLE sub_agent_executions DROP COLUMN recovery_messages',
      [],
      signal
    )
    await database.query(
      `INSERT INTO sub_agent_executions (execution_id, session_id, agent_id, status)
       VALUES ('SAEX_OLD', 'SESSION_OLD', 'AGENT_OLD', 'pending')`,
      [],
      signal
    )

    assert.deepEqual(await new PostgresMigrator(database).up(signal), {
      groupId: 2,
      migrationNames: ['20260908000003', '20260911000001'],
    })
    const rows = await database.query('SELECT execution_id FROM sub_agent_executions', [], signal)
    assert.equal(rows.rowCount, 0)

    await database.query(
      `INSERT INTO sub_agent_executions (execution_id, session_id, agent_id, status)
       VALUES ('SAEX_AFTER_REPAIR', 'SESSION_NEW', 'AGENT_NEW', 'pending')`,
      [],
      signal
    )
    await new PostgresMigrator(database).down(signal)
    await new PostgresMigrator(database).up(signal)
    const replayedRows = await database.query(
      "SELECT execution_id FROM sub_agent_executions WHERE execution_id = 'SAEX_AFTER_REPAIR'",
      [],
      signal
    )
    assert.equal(replayedRows.rowCount, 1)
    assert.deepEqual(await subExecutionConcurrencyColumns(database, signal), [
      'pending_interrupt_id',
      'recovery_messages',
      'revision',
    ])

    const repository = new PostgresSubExecutionRepository(database)
    const record = integrationSubExecution()
    await repository.create(record, signal)
    record.status = 'completed'
    await repository.update(record, signal)
    assert.equal(record.revision, 1n)
    const stale = { ...record, revision: 0n }
    await assert.rejects(repository.update(stale, signal), /revision 冲突/u)
  } finally {
    if (database !== undefined) await database.close()
    await admin.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(temporaryDatabaseName)} WITH (FORCE)`,
      [],
      signal
    )
    await admin.close()
  }
})
