import type { User } from '../model/user.js'
import type { PublicUserDto, SelfUserDto } from './identity.dto.js'
import { optionalField } from '../../../shared/object/optional-field.js'

/** 对外公开的用户信息；**不含邮箱**——邮箱只出现在「看自己」的视图里。 */
export function toPublicUserDto(user: User): PublicUserDto {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    ...optionalField('avatar', user.avatar),
  }
}

/** 自己的用户视图；在公开信息之上补 `email`，字段定义因此只有一处。 */
export function toSelfUserDto(user: User): SelfUserDto {
  return { ...toPublicUserDto(user), email: user.email }
}
