import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  IDENTITY_APPLICATION_ERROR_CODES,
  IdentityApplicationError,
} from '../../../../../src/modules/identity/service/application/error/identity-application-error.js'
import { IdentityProfileService } from '../../../../../src/modules/identity/service/application/profile/identity-profile-service.js'
import { IdentityRegistrationService } from '../../../../../src/modules/identity/service/application/registration/identity-registration-service.js'
import type { PasswordHasher } from '../../../../../src/modules/identity/service/authentication/port/password-hasher.port.js'
import type { User } from '../../../../../src/modules/identity/model/user.js'
import type { UserRepository } from '../../../../../src/modules/identity/service/user-repository/port/user-repository.port.js'
import type { IdGenerator } from '../../../../../src/shared/id/id-generator.js'

const SIGNAL = new AbortController().signal
const NOW = new Date('2026-09-09T00:00:00.000Z')

class MemoryUsers implements UserRepository {
  readonly #users = new Map<string, User>()

  public constructor(users: readonly User[] = []) {
    for (const user of users) this.#users.set(user.id, structuredClone(user))
  }

  public create(user: User): Promise<void> {
    this.#users.set(user.id, structuredClone(user))
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
    const users = [...this.#users.values()]
    return Promise.resolve({
      users: structuredClone(users.slice(offset, offset + limit)),
      total: users.length,
    })
  }
}

const HASHER: PasswordHasher = {
  hash(password: string): Promise<string> {
    return Promise.resolve(`hashed:${password}`)
  },
  verify(): Promise<void> {
    return Promise.resolve()
  },
}

const IDS: IdGenerator = { generate: (): string => 'USER_NEW' }

function existingUser(): User {
  return {
    id: 'USER_1',
    username: 'alice',
    email: 'alice@example.com',
    passwordHash: 'hash',
    displayName: 'Alice',
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

void describe('Identity application services', () => {
  void it('registers a user without coupling registration to token operations', async () => {
    const service = new IdentityRegistrationService({
      users: new MemoryUsers(),
      passwordHasher: HASHER,
      idGenerator: IDS,
      now: (): Date => NOW,
    })

    const user = await service.register(
      {
        username: 'new-user',
        email: 'new@example.com',
        password: 'secret',
        displayName: 'New User',
      },
      SIGNAL
    )

    assert.equal(user.id, 'USER_NEW')
    assert.equal(user.passwordHash, 'hashed:secret')
  })

  void it('updates profiles and reports a stable missing-user error', async () => {
    const users = new MemoryUsers([existingUser()])
    const service = new IdentityProfileService({ users, now: (): Date => NOW })

    const updated = await service.updateSelf({ userId: 'USER_1', displayName: 'Updated' }, SIGNAL)
    assert.equal(updated.displayName, 'Updated')
    await assert.rejects(service.getSelf('MISSING', SIGNAL), (error: unknown): boolean => {
      assert.ok(error instanceof IdentityApplicationError)
      assert.equal(error.code, IDENTITY_APPLICATION_ERROR_CODES.NOT_FOUND)
      return true
    })
  })
})
