import type { User } from '../model/user.js'
import type { PublicUserDto, SelfUserDto } from './identity.dto.js'
import { optionalField } from '../../../shared/object/optional-field.js'

/**
 * 对外公开的用户信息；**不含邮箱**——邮箱只出现在「看自己」的视图里。
 *
 * 投影方向固定为「领域实体 → 响应 DTO」：入参已是经仓储读出的可信实体，本函数不再做
 * 任何校验或补默认值。裁剪发生在这一层而不是 Controller，是为了让「公开视图含哪些字段」
 * 只有一个出口；`avatar` 走 `optionalField`，缺失时不落 `undefined` 键。
 *
 * @param user - 领域层的用户实体；仅读取字段做投影，不会被修改
 * @returns 不含邮箱的公开视图，可直接序列化进成功信封
 */
export function toPublicUserDto(user: User): PublicUserDto {
  return {
    id: user.id,
    username: user.username,
    display_name: user.displayName,
    ...optionalField('avatar', user.avatar),
  }
}

/**
 * 自己的用户视图；在公开信息之上补 `email`，字段定义因此只有一处。
 *
 * 复用 `toPublicUserDto` 再叠加邮箱，避免两个视图的公共字段各写一遍而漂移；这是一次
 * 无副作用的纯投影，失败语义为空（不会抛错，字段缺失由可选投影吸收）。
 *
 * @param user - 领域层的用户实体；仅读取字段做投影，不会被修改
 * @returns 含邮箱的自有视图，仅应回给用户本人
 */
export function toSelfUserDto(user: User): SelfUserDto {
  return { ...toPublicUserDto(user), email: user.email }
}
