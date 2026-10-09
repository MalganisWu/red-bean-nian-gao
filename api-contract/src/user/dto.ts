export interface RegisterUserDto {
  readonly username: string
  readonly email: string
  readonly password: string
  readonly display_name: string
  readonly avatar?: string | null | undefined
}

export interface LoginDto {
  readonly username: string
  readonly password: string
}

export interface UpdateSelfDto {
  readonly display_name?: string | undefined
  readonly avatar?: string | null | undefined
  readonly email?: string | undefined
}

export interface PublicUserDto {
  readonly id: string
  readonly username: string
  readonly display_name: string
  readonly avatar?: string | undefined
}

export interface SelfUserDto extends PublicUserDto {
  readonly email: string
}

export interface TokenDto {
  readonly token: string
}

export interface UserListDto {
  readonly users: PublicUserDto[]
  readonly total: number
}
