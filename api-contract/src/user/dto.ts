/** 注册请求体；`password` 在这一层仍是明文，只受传输层加密保护。 */
export interface RegisterUserDto {
  readonly username: string
  readonly email: string
  readonly password: string
  readonly display_name: string
  readonly avatar?: string | null | undefined
}

/** 登录请求体；用户名 + 明文密码。 */
export interface LoginDto {
  readonly username: string
  readonly password: string
}

/** 更新自己资料的请求体；字段全可选，缺省即不改该项。 */
export interface UpdateSelfDto {
  readonly display_name?: string | undefined
  readonly avatar?: string | null | undefined
  readonly email?: string | undefined
}

/** 对外可见的用户信息；**不含邮箱**，邮箱只出现在 `SelfUserDto`。 */
export interface PublicUserDto {
  readonly id: string
  readonly username: string
  readonly display_name: string
  readonly avatar?: string | undefined
}

/** 自己的用户信息；在公开字段之上补 `email`。 */
export interface SelfUserDto extends PublicUserDto {
  readonly email: string
}

/** 登录/刷新成功返回的访问令牌。 */
export interface TokenDto {
  readonly token: string
}

/** 用户列表；`total` 是符合条件的总数，不是 `users` 的长度。 */
export interface UserListDto {
  readonly users: PublicUserDto[]
  readonly total: number
}
