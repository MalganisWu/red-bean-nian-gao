import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import type { IdGenerator } from '../../../../src/shared/id/id-generator.js'

import { createHttpServer } from '../../../../src/shared/http/fastify-http-boundary.js'
import { registerUserRoutes } from '../../../../src/modules/identity/http-api.js'
import { IdentityProfileService } from '../../../../src/modules/identity/service/application/profile/identity-profile-service.js'
import { IdentityRegistrationService } from '../../../../src/modules/identity/service/application/registration/identity-registration-service.js'
import type { User } from '../../../../src/modules/identity/model/user.js'
import type { PasswordHasher } from '../../../../src/modules/identity/service/authentication/port/password-hasher.port.js'
import {
  UserRepositoryConflictError,
  type UserRepository,
} from '../../../../src/modules/identity/service/user-repository/port/user-repository.port.js'
import type { AuthServicePort } from '../../../../src/modules/identity/service/authentication/port/auth-service.port.js'

class FixedIdGenerator implements IdGenerator {
  public generate(prefix: string): string {
    return `${prefix}_test`
  }
}

class FakeAuthService implements AuthServicePort {
  public login(): Promise<string> {
    return Promise.resolve('jwt-token')
  }

  public logout(): Promise<void> {
    return Promise.resolve()
  }

  public validateToken(): Promise<string> {
    return Promise.resolve('user_1')
  }

  public refreshToken(): Promise<string> {
    return Promise.resolve('refreshed-token')
  }
}

class FakeUserRepository implements UserRepository {
  readonly #users = new Map<string, User>()
  readonly #order: string[] = []

  public constructor(users: readonly User[]) {
    for (const user of users) {
      this.#users.set(user.id, structuredClone(user))
      this.#order.push(user.id)
    }
  }

  public create(user: User): Promise<void> {
    this.#users.set(user.id, structuredClone(user))
    this.#order.push(user.id)
    return Promise.resolve()
  }

  public getById(userId: string): Promise<User | undefined> {
    return Promise.resolve(structuredClone(this.#users.get(userId)))
  }

  public getByUsername(username: string): Promise<User | undefined> {
    return Promise.resolve(
      structuredClone([...this.#users.values()].find((user): boolean => user.username === username))
    )
  }

  public getByEmail(email: string): Promise<User | undefined> {
    return Promise.resolve(
      structuredClone([...this.#users.values()].find((user): boolean => user.email === email))
    )
  }

  public update(user: User): Promise<void> {
    this.#users.set(user.id, structuredClone(user))
    return Promise.resolve()
  }

  public delete(userId: string): Promise<void> {
    this.#users.delete(userId)
    return Promise.resolve()
  }

  public list(
    offset: number,
    limit: number
  ): Promise<{ readonly users: readonly User[]; readonly total: number }> {
    const users = this.#order
      .map((id): User | undefined => this.#users.get(id))
      .filter((user): user is User => user !== undefined)
    return Promise.resolve({
      users: structuredClone(users.slice(offset, offset + limit)),
      total: users.length,
    })
  }
}

class ConcurrentRegistrationRepository extends FakeUserRepository {
  public override create(): Promise<void> {
    return Promise.reject(
      new UserRepositoryConflictError('用户唯一键冲突', new Error('concurrent insert won'))
    )
  }
}

const UNUSED_HASHER: PasswordHasher = {
  hash(): Promise<string> {
    return Promise.resolve('hashed')
  },
  verify(): Promise<void> {
    return Promise.resolve()
  },
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function userContractGolden(): Promise<Readonly<Record<string, unknown>>> {
  const document = await readFile(path.resolve(process.cwd(), '../docs/contracts/api.md'), 'utf8')
  const startMarker = '<!-- USER-GOLDEN-START -->'
  const endMarker = '<!-- USER-GOLDEN-END -->'
  const start = document.indexOf(startMarker)
  const end = document.indexOf(endMarker)
  assert.ok(start >= 0 && end > start, 'missing USER-GOLDEN markers')
  const json = document
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/^```json\s*/u, '')
    .replace(/\s*```$/u, '')
  const parsed: unknown = JSON.parse(json)
  assert.ok(isRecord(parsed))
  return parsed
}

function user(id: string, username: string, email: string, displayName: string): User {
  const now = new Date('2026-09-04T12:00:00.000Z')
  return {
    id,
    username,
    email,
    passwordHash: 'hash',
    displayName,
    avatar: id === 'user_2' ? 'https://x/a.png' : undefined,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }
}

async function buildServer(users: readonly User[]) {
  const idGenerator = new FixedIdGenerator()
  const authService = new FakeAuthService()
  const userRepository = new FakeUserRepository(users)
  const registration = new IdentityRegistrationService({
    users: userRepository,
    passwordHasher: UNUSED_HASHER,
    idGenerator,
    now: (): Date => new Date('2026-09-04T12:00:00.000Z'),
  })
  const profiles = new IdentityProfileService({
    users: userRepository,
    now: (): Date => new Date('2026-09-04T12:00:00.000Z'),
  })
  const server = createHttpServer({ idGenerator })
  registerUserRoutes(server, {
    registration,
    profiles,
    authService,
  })
  await server.ready()
  return server
}

async function buildServerWithRepository(users: UserRepository) {
  const idGenerator = new FixedIdGenerator()
  const authService = new FakeAuthService()
  const registration = new IdentityRegistrationService({
    users,
    passwordHasher: UNUSED_HASHER,
    idGenerator,
    now: (): Date => new Date('2026-09-04T12:00:00.000Z'),
  })
  const profiles = new IdentityProfileService({
    users,
    now: (): Date => new Date('2026-09-04T12:00:00.000Z'),
  })
  const server = createHttpServer({ idGenerator })
  registerUserRoutes(server, { registration, profiles, authService })
  await server.ready()
  return server
}

void describe('Fastify user route parity', () => {
  void it('returns HTTP 409 when a concurrent registration wins the database unique key', async () => {
    const server = await buildServerWithRepository(new ConcurrentRegistrationRepository([]))

    const response = await server.inject({
      method: 'POST',
      url: '/api/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        username: 'alice',
        email: 'alice@example.com',
        password: 'password',
        display_name: 'Alice',
      },
    })

    assert.equal(response.statusCode, 409)
    assert.deepEqual(response.json(), {
      code: 4009,
      message: '用户名或邮箱已存在',
      data: null,
    })
    await server.close()
  })

  void it('wraps a successful login token in the stable response envelope', async () => {
    const server = await buildServer([])
    const response = await server.inject({
      method: 'POST',
      url: '/api/login',
      headers: { 'content-type': 'application/json' },
      payload: { username: 'u', password: 'p' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { code: 200, data: { token: 'jwt-token' } })
    await server.close()
  })

  void it('returns own email without internal account fields', async () => {
    const golden = await userContractGolden()
    const server = await buildServer([user('user_1', 'alice', 'alice@example.com', 'Alice')])
    const response = await server.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: 'Bearer jwt-token' },
    })
    assert.equal(response.statusCode, 200)
    const body: unknown = response.json()
    assert.deepEqual(body, { code: 200, data: golden['self_user'] })
    assert.equal(JSON.stringify(body).includes('is_active'), false)
    assert.equal(JSON.stringify(body).includes('created_at'), false)
    await server.close()
  })

  void it('does not expose PII when reading another user', async () => {
    const golden = await userContractGolden()
    const server = await buildServer([user('user_2', 'bob', 'bob@example.com', 'Bob')])
    const response = await server.inject({
      method: 'GET',
      url: '/api/users/user_2',
      headers: { authorization: 'Bearer jwt-token' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { code: 200, data: golden['public_user'] })
    await server.close()
  })

  void it('does not expose email in the user list', async () => {
    const golden = await userContractGolden()
    const server = await buildServer([
      user('user_1', 'alice', 'alice@example.com', 'Alice'),
      user('user_2', 'bob', 'bob@example.com', 'Bob'),
    ])
    const response = await server.inject({
      method: 'GET',
      url: '/api/users?offset=0&limit=20',
      headers: { authorization: 'Bearer jwt-token' },
    })
    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), { code: 200, data: golden['user_list'] })
    await server.close()
  })
})
