import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PostgresUserRepository } from '../../../../../src/modules/identity/service/user-repository/postgres-user-repository.js'
import type { User } from '../../../../../src/modules/identity/model/user.js'
import { UserRepositoryConflictError } from '../../../../../src/modules/identity/service/user-repository/port/user-repository.port.js'
import type { SqlExecutor, SqlQueryResult } from '../../../../../src/infra/database/postgres.js'

interface RecordedQuery {
  readonly sql: string
  readonly parameters: readonly unknown[]
}

class RecordingSqlExecutor implements SqlExecutor {
  public readonly queries: RecordedQuery[] = []
  public readonly results: SqlQueryResult[] = []
  public error: Error | undefined

  public query(
    sql: string,
    parameters: readonly unknown[],
    signal: AbortSignal
  ): Promise<SqlQueryResult> {
    signal.throwIfAborted()
    this.queries.push({ sql, parameters })
    if (this.error !== undefined) return Promise.reject(this.error)
    return Promise.resolve(this.results.shift() ?? { rows: [], rowCount: 0 })
  }
}

const createdAt = new Date('2026-08-01T00:00:00.000Z')
const updatedAt = new Date('2026-08-02T00:00:00.000Z')
const user: User = {
  id: 'USER_1',
  username: 'alice',
  email: 'alice@example.com',
  passwordHash: '$2b$10$hash',
  displayName: 'Alice',
  avatar: '/avatar.png',
  isActive: true,
  createdAt,
  updatedAt,
}

const databaseRow = {
  id: 'USER_1',
  username: 'alice',
  email: 'alice@example.com',
  password_hash: '$2b$10$hash',
  display_name: 'Alice',
  avatar: '/avatar.png',
  is_active: true,
  created_at: createdAt,
  updated_at: updatedAt,
}

void describe('PostgreSQL user repository', () => {
  void it('creates users with the existing schema columns', async () => {
    const database = new RecordingSqlExecutor()
    const repository = new PostgresUserRepository(database)

    await repository.create(user, AbortSignal.timeout(1_000))

    assert.match(database.queries[0]?.sql ?? '', /INSERT INTO users/u)
    assert.deepEqual(database.queries[0]?.parameters, [
      'USER_1',
      'alice',
      'alice@example.com',
      '$2b$10$hash',
      'Alice',
      '/avatar.png',
      true,
      createdAt,
      updatedAt,
    ])
  })

  void it('reads users by ID, username and email and returns undefined when absent', async () => {
    const database = new RecordingSqlExecutor()
    database.results.push(
      { rows: [databaseRow], rowCount: 1 },
      { rows: [databaseRow], rowCount: 1 },
      { rows: [databaseRow], rowCount: 1 },
      { rows: [], rowCount: 0 }
    )
    const repository = new PostgresUserRepository(database)
    const signal = AbortSignal.timeout(1_000)

    assert.deepEqual(await repository.getById('USER_1', signal), user)
    assert.deepEqual(await repository.getByUsername('alice', signal), user)
    assert.deepEqual(await repository.getByEmail('alice@example.com', signal), user)
    assert.equal(await repository.getById('missing', signal), undefined)
    assert.deepEqual(
      database.queries.map((query): readonly unknown[] => query.parameters),
      [['USER_1'], ['alice'], ['alice@example.com'], ['missing']]
    )
  })

  void it('rejects malformed rows at the database trust boundary', async () => {
    const database = new RecordingSqlExecutor()
    database.results.push({ rows: [{ ...databaseRow, is_active: 'yes' }], rowCount: 1 })
    const repository = new PostgresUserRepository(database)

    await assert.rejects(
      repository.getById('USER_1', AbortSignal.timeout(1_000)),
      /查询用户失败 \(id=USER_1\)：用户行数据非法/u
    )
  })

  void it('updates mutable fields and soft-deletes users', async () => {
    const database = new RecordingSqlExecutor()
    const now = new Date('2026-08-03T00:00:00.000Z')
    const repository = new PostgresUserRepository(database, (): Date => now)
    const signal = AbortSignal.timeout(1_000)

    await repository.update(user, signal)
    await repository.delete('USER_1', signal)

    assert.match(database.queries[0]?.sql ?? '', /UPDATE users/u)
    assert.deepEqual(database.queries[0]?.parameters, [
      'alice@example.com',
      'Alice',
      '/avatar.png',
      true,
      now,
      'USER_1',
    ])
    assert.match(database.queries[1]?.sql ?? '', /is_active = FALSE/u)
    assert.deepEqual(database.queries[1]?.parameters, [now, 'USER_1'])
  })

  void it('lists active users in creation order with a stable total', async () => {
    const database = new RecordingSqlExecutor()
    database.results.push({
      rows: [
        { ...databaseRow, total_count: '2' },
        { ...databaseRow, id: 'USER_2', total_count: '2' },
      ],
      rowCount: 2,
    })
    const repository = new PostgresUserRepository(database)

    const page = await repository.list(5, 10, AbortSignal.timeout(1_000))

    assert.equal(page.total, 2)
    assert.deepEqual(
      page.users.map((item): string => item.id),
      ['USER_1', 'USER_2']
    )
    assert.match(database.queries[0]?.sql ?? '', /WHERE is_active = TRUE/u)
    assert.match(database.queries[0]?.sql ?? '', /ORDER BY created_at DESC/u)
    assert.deepEqual(database.queries[0]?.parameters, [10, 5])
  })

  void it('wraps database errors with operation context', async () => {
    const database = new RecordingSqlExecutor()
    database.error = new Error('connection lost')
    const repository = new PostgresUserRepository(database)

    await assert.rejects(
      repository.getByEmail('alice@example.com', AbortSignal.timeout(1_000)),
      (error: unknown): boolean => {
        assert.ok(error instanceof Error)
        assert.equal(error.message, '查询用户失败 (email=alice@example.com)：connection lost')
        assert.equal(error.cause, database.error)
        return true
      }
    )
  })

  void it('maps PostgreSQL unique violations to a stable repository conflict', async () => {
    const database = new RecordingSqlExecutor()
    const uniqueViolation = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint: 'users_username_key',
    })
    database.error = uniqueViolation
    const repository = new PostgresUserRepository(database)

    await assert.rejects(
      repository.create(user, AbortSignal.timeout(1_000)),
      (error: unknown): boolean => {
        assert.ok(error instanceof UserRepositoryConflictError)
        assert.equal(error.cause, uniqueViolation)
        return true
      }
    )
  })
})
