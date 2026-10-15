// 前端兼容命名；字段定义统一来自共享 API 契约包。
export type {
  LoginDto as LoginRequest,
  PublicUserDto as PublicUser,
  RegisterUserDto as RegisterRequest,
  SelfUserDto as User,
  TokenDto as LoginResponse,
  TokenDto as RefreshResponse,
} from '@red-bean/api-contract'
