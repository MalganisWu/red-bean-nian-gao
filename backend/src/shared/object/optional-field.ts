/**
 * 可空字段的具名条件展开助手：值存在时展开为 `{ key: value }`，否则展开为空对象。
 *
 * 存在理由是 `exactOptionalPropertyTypes`：该选项下 `{ field: undefined }` 不能赋值给 `{ field?: T }`，
 * 可选字段的"键缺失"与"键存在但为 undefined"必须区分。直接用 `...(cond ? {} : { field })` 表达该语义
 * 会把三元表达式内联进参数位置，掩盖入参含义（见 `docs/standards/typescript-coding-conventions.md`
 * 「表达式与调用可读性」），因此全仓统一改用本助手。
 *
 * 仅适用于"条件即空值判断、键与值同名同形"的场景；带类型转换、字段改名、多条件或可选链取值的位置
 * 需要各自的具名小助手，不得强行套用（如 `row.error === null || row.error === ''` 的空字符串语义）。
 * @param key - 展开后的字段名。
 * @param value - 字段值；为 `null` 或 `undefined` 时展开为空对象。
 * @returns 值存在时为 `{ [key]: value }`，否则为空对象。
 */
export function optionalField<TValue>(
  key: string,
  value: TValue | null | undefined
): Readonly<Record<string, TValue>> {
  return value === null || value === undefined ? {} : { [key]: value }
}
