export interface ObjectInfoDto {
  readonly key: string
  readonly size: number
  readonly content_type: string
  readonly etag: string
}

export interface PresignRequestDto {
  readonly key: string
  readonly expires?: number | undefined
}
