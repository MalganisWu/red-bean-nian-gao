/** 按 Unicode code point 截断文本，避免把代理对切成半个字符；超出时追加可选后缀。 */
export function truncateCodePoints(value: string, maxLength: number, suffix = ''): string {
  const codePoints = Array.from(value)
  if (codePoints.length <= maxLength) return value
  return `${codePoints.slice(0, maxLength).join('')}${suffix}`
}
