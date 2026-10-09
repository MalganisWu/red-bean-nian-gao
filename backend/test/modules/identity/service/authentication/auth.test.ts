import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SignJWT } from 'jose'

import { JwtAuthService } from '../../../../../src/modules/identity/service/authentication/default-auth-service.js'
import {
  AUTH_ERROR_CODES,
  AuthError,
  type User,
} from '../../../../../src/modules/identity/model/user.js'
import type { PasswordHasher } from '../../../../../src/modules/identity/service/authentication/port/password-hasher.port.js'
import type { UserRepository } from '../../../../../src/modules/identity/service/user-repository/port/user-repository.port.js'

const NOW = new Date('2026-09-04T12:00:00.000Z')
const SECRET = 'test-secret-that-is-long-enough-for-tests'
const SIGNAL = new AbortController().signal

class StubUserRepository implements UserRepository {
  public user: User | undefined

  public constructor(user: User | undefined) {
    this.user = user
  }

  public create(): Promise<void> {
    return Promise.resolve()
  }

  public getById(): Promise<User | undefined> {
    return Promise.resolve(this.user)
  }

  public getByUsername(): Promise<User | undefined> {
    return Promise.resolve(this.user)
  }

  public getByEmail(): Promise<User | undefined> {
    return Promise.resolve(this.user)
  }

  public update(): Promise<void> {
    return Promise.resolve()
  }

  public delete(): Promise<void> {
    return Promise.resolve()
  }

  public list(): Promise<{ readonly users: readonly User[]; readonly total: number }> {
    return Promise.resolve({ users: [], total: 0 })
  }
}

const UNUSED_HASHER: PasswordHasher = {
  hash(): Promise<string> {
    return Promise.resolve('hash')
  },
  verify(): Promise<void> {
    return Promise.resolve()
  },
}

function testUser(active: boolean): User {
  return {
    id: 'USER_1',
    username: 'alice',
    email: 'alice@example.com',
    passwordHash: 'hash',
    displayName: 'Alice',
    isActive: active,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function service(user: User): JwtAuthService {
  return new JwtAuthService({
    userRepository: new StubUserRepository(user),
    passwordHasher: UNUSED_HASHER,
    secret: SECRET,
    tokenDurationMilliseconds: 60 * 60 * 1_000,
    refreshMaxAgeMilliseconds: 7 * 24 * 60 * 60 * 1_000,
    now: (): Date => NOW,
  })
}

async function signTestToken(algorithm: 'HS256' | 'HS384', issuedAt: Date): Promise<string> {
  const seconds = Math.floor(issuedAt.getTime() / 1_000)
  return new SignJWT({ user_id: 'USER_1', username: 'alice' })
    .setProtectedHeader({ alg: algorithm })
    .setIssuedAt(seconds)
    .setExpirationTime(seconds + 60 * 60)
    .sign(new TextEncoder().encode(SECRET))
}

async function expectAuthError(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, (error: unknown): boolean => {
    assert.ok(error instanceof AuthError)
    assert.equal(error.code, code)
    return true
  })
}

void describe('JWT authentication parity', () => {
  void it('rejects tokens outside the refresh window', async () => {
    const issuedAt = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1_000)
    const token = await signTestToken('HS256', issuedAt)
    await expectAuthError(
      service(testUser(true)).refreshToken(token, SIGNAL),
      AUTH_ERROR_CODES.TOKEN_EXPIRED
    )
  })

  void it('rejects a disabled user during refresh', async () => {
    const token = await signTestToken('HS256', NOW)
    await expectAuthError(
      service(testUser(false)).refreshToken(token, SIGNAL),
      AUTH_ERROR_CODES.INVALID_TOKEN
    )
  })

  void it('rejects an unexpected signing algorithm', async () => {
    const token = await signTestToken('HS384', NOW)
    await expectAuthError(
      service(testUser(true)).refreshToken(token, SIGNAL),
      AUTH_ERROR_CODES.INVALID_TOKEN
    )
  })

  void it('allows a recently expired access token to refresh', async () => {
    const issuedAt = new Date(NOW.getTime() - 2 * 60 * 60 * 1_000)
    const auth = service(testUser(true))
    const token = await signTestToken('HS256', issuedAt)
    const refreshed = await auth.refreshToken(token, SIGNAL)
    assert.notEqual(refreshed, '')
    assert.equal(await auth.validateToken(refreshed, SIGNAL), 'USER_1')
  })
})
