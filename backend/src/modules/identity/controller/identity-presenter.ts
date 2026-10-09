import type { User } from '../model/user.js'
import type { PublicUserDto, SelfUserDto } from './identity.dto.js'
import { optionalField } from '../../../shared/object/optional-field.js'

export function toPublicUserDto(user: User): PublicUserDto {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    ...optionalField('avatar', user.avatar),
  }
}

export function toSelfUserDto(user: User): SelfUserDto {
  return { ...toPublicUserDto(user), email: user.email }
}
