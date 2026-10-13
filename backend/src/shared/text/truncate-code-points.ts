/**
 * 按 Unicode code point 截断文本，避免把代理对切成半个字符；超出时追加可选后缀。
 * @param value - 待截断的文本。
 * @param maxLength - 允许保留的最大 code point 数；不超过时原样返回。
 * @param suffix - 发生截断时追加的后缀，缺省为空串。
 * @returns 截断（必要时加后缀）后的文本。
 */
export function truncateCodePoints(value: string, maxLength: number, suffix = ''): string {
  const codePoints = Array.from(value)
  if (codePoints.length <= maxLength) return value
  return `${codePoints.slice(0, maxLength).join('')}${suffix}`
}
