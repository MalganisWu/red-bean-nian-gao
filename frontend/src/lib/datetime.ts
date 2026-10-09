// 时间字段的统一展示入口。
//
// 契约里时间字段是可选的（如 `RunAt?: string | undefined`），后端在无值时**省略整个字段**，
// 不会序列化占位值。因此这里只需区分「有值 / 无值」，无需识别任何哨兵时间串。

/** 是否为空时间：undefined / null / 空串均视为无 */
export function isAbsentTime(value: string | undefined | null): boolean {
  return !value
}

/** 格式化时间为本地字符串；空时间返回 fallback（默认「—」） */
export function formatDateTime(value: string | undefined | null, fallback = '—'): string {
  if (!value) return fallback
  return new Date(value).toLocaleString('zh-CN')
}

/** 短格式 MM-DD HH:mm（补零）——列表 meta 小注用；空时间返回 fallback（默认「—」） */
export function formatShortDateTime(value: string | undefined | null, fallback = '—'): string {
  if (!value) return fallback
  const d = new Date(value)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
