import type { SqlExecutor } from '../../infra/database/postgres.js'
import type { IdGenerator } from '../../shared/id/id-generator.js'
import type { AuthServicePort } from './service/authentication/port/auth-service.port.js'
import type { PasswordHasher } from './service/authentication/port/password-hasher.port.js'
import {
  BcryptPasswordHasher,
  JwtAuthService,
} from './service/authentication/default-auth-service.js'
import { IdentityProfileService } from './service/application/profile/identity-profile-service.js'
import { IdentityRegistrationService } from './service/application/registration/identity-registration-service.js'
import { PostgresUserRepository } from './service/user-repository/postgres-user-repository.js'

/** Identity Module 的输出面：认证服务、密码散列器与两个用例服务。 */
export interface IdentityModule {
  readonly authService: AuthServicePort
  readonly passwordHasher: PasswordHasher
  readonly registrationService: IdentityRegistrationService
  readonly profileService: IdentityProfileService
}

/** 在 Identity Module 内明确绑定认证、密码散列与用户仓储的生产实现。 */
export function createIdentityModule(
  database: SqlExecutor,
  idGenerator: IdGenerator,
  jwtSecret: string,
  passwordHasher = new BcryptPasswordHasher()
): IdentityModule {
  const userRepository = new PostgresUserRepository(database)
  const authService = new JwtAuthService({ userRepository, passwordHasher, secret: jwtSecret })
  const registrationService = new IdentityRegistrationService({
    users: userRepository,
    passwordHasher,
    idGenerator,
  })
  const profileService = new IdentityProfileService({ users: userRepository })
  return {
    authService,
    passwordHasher,
    registrationService,
    profileService,
  }
}
