import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** 拼接 className 并消解 Tailwind 冲突：同类工具类由后者覆盖前者。 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
