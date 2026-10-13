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
  /** 认证服务；跨 Module 只经由此端口调用登录、注销、续签与令牌校验。 */
  readonly authService: AuthServicePort
  /** 实际生效的密码散列器；回吐它是为了让上层确认注入被采纳，而非各处置换。 */
  readonly passwordHasher: PasswordHasher
  /** 注册用例服务；承接唯一性校验、散列与落库。 */
  readonly registrationService: IdentityRegistrationService
  /** 资料用例服务；承接自有视图与公开视图的读取与更新。 */
  readonly profileService: IdentityProfileService
}

/**
 * 在 Identity Module 内明确绑定认证、密码散列与用户仓储的生产实现。
 *
 * 是 Module 内实现选择的事实来源：跨 Module 只暴露 Port 与用例服务，具体类名不外泄。
 * 显式 `new` 各实现，避免依赖结构化类型巧合。
 *
 * @param database - 共享的 SQL 执行器；用户仓储在其上运行，不持有自己的连接池
 * @param idGenerator - 用户 ID 生成器；注入而非各服务内自造，保证 ID 策略全局一致
 * @param jwtSecret - 令牌签名密钥，来自启动期配置；不得硬编码或落日志
 * @param passwordHasher - 密码散列器；默认用 bcrypt，测试可注入轻量实现，生产不应替换
 * @returns 认证服务、实际使用的散列器与两个用例服务
 */
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
