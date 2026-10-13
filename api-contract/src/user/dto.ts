/** 注册请求体；`password` 在这一层仍是明文，只受传输层加密保护。 */
export interface RegisterUserDto {
  /** 登录用户名；全局唯一，服务端校验是否已占用。 */
  readonly username: string
  /** 邮箱；用于找回与通知。 */
  readonly email: string
  /** 明文密码，只受传输层加密保护；服务端哈希后落库，不会回传。 */
  readonly password: string
  /** 展示名；缺省由服务端按用户名补默认值。 */
  readonly display_name: string
  /** 头像地址；null 或缺失表示未设置。 */
  readonly avatar?: string | null | undefined
}

/** 登录请求体；用户名 + 明文密码。 */
export interface LoginDto {
  /** 登录用户名。 */
  readonly username: string
  /** 明文密码；服务端比对哈希后换取 token。 */
  readonly password: string
}

/** 更新自己资料的请求体；字段全可选，缺省即不改该项。 */
export interface UpdateSelfDto {
  /** 新的展示名；缺省表示不改。 */
  readonly display_name?: string | undefined
  /** 新的头像地址；null 表示清除头像，缺省表示不改。 */
  readonly avatar?: string | null | undefined
  /** 新邮箱；缺省表示不改。 */
  readonly email?: string | undefined
}

/** 对外可见的用户信息；**不含邮箱**，邮箱只出现在 `SelfUserDto`。 */
export interface PublicUserDto {
  /** 用户 ID。 */
  readonly id: string
  /** 登录用户名。 */
  readonly username: string
  /** 展示名。 */
  readonly display_name: string
  /** 头像地址；缺省表示未设置，前端据此回落到默认头像。 */
  readonly avatar?: string | undefined
}

/** 自己的用户信息；在公开字段之上补 `email`。 */
export interface SelfUserDto extends PublicUserDto {
  /** 邮箱；仅自己可见，不出现在 `PublicUserDto`。 */
  readonly email: string
}

/** 登录/刷新成功返回的访问令牌。 */
export interface TokenDto {
  /** 访问令牌本体，使用时以 `Bearer` 前缀置于 Authorization 头。 */
  readonly token: string
}

/** 用户列表；`total` 是符合条件的总数，不是 `users` 的长度。 */
export interface UserListDto {
  /** 当前页的用户。 */
  readonly users: PublicUserDto[]
  /** 符合条件的总数，不是 `users` 的长度（分页时两者常不相等）。 */
  readonly total: number
}
