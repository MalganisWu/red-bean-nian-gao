import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 拼接 className 并消解 Tailwind 冲突：同类工具类由后者覆盖前者。
 *
 * @param inputs - 依次参与拼接的类名片段（字符串、数组、条件对象皆可）；尾部同类工具类胜出。
 * @returns 合并后的 className 字符串。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
