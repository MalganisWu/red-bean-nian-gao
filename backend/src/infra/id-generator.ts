import { randomBytes } from 'node:crypto'

import type { IdGenerator } from '../shared/id/id-generator.js'

/** 后缀字符表：仅小写字母与数字，共 36 个字符；不含分隔符以避免与 `_` 混淆。 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
/** 随机后缀的字符数；固定 8 位，是同一毫秒内多个 ID 不重复的唯一来源。 */
const SUFFIX_LENGTH = 8

/** 毫秒时钟；可注入，生成的 ID 因此能在测试里确定。 */
export type MillisecondClock = () => number
/** 随机字节源；可注入，测试可构造确定的随机后缀。 */
export type RandomByteSource = (size: number) => Uint8Array

/** 生成与既有产品 wire 格式一致的不透明 ID。 */
export class TimestampIdGenerator implements IdGenerator {
  /** 毫秒时钟；构造时注入，使生成结果在测试中可复现。 */
  readonly #clock: MillisecondClock
  /** 随机字节源；构造时注入，测试可据其构造确定的随机后缀。 */
  readonly #randomBytes: RandomByteSource

  public constructor(
    clock: MillisecondClock = Date.now,
    randomByteSource: RandomByteSource = randomBytes
  ) {
    this.#clock = clock
    this.#randomBytes = randomByteSource
  }

  /**
   * 生成 `<prefix>_<毫秒时间戳><8 位随机后缀>` 形态的不透明 ID。
   * 前缀按业务实体区分（如 `sess`、`msg`），后缀取自可注入的随机源。
   * 时钟非安全整数或随机源长度不符时直接抛错，不做兜底——生成出格式错误的 ID
   * 会污染持久化数据，宁可让调用点立刻失败。
   * @param prefix - ID 的业务前缀，不含分隔符；分隔符 `_` 由本方法拼接
   * @returns 拼接完成的 ID 字符串；时间戳为十进制文本，因此同一毫秒内仍靠随机后缀区分
   */
  public generate(prefix: string): string {
    const timestamp = this.#clock()
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error('ID timestamp must be a non-negative safe integer')
    }
    const bytes = this.#randomBytes(SUFFIX_LENGTH)
    if (bytes.length !== SUFFIX_LENGTH) throw new Error('ID random source returned invalid length')
    let suffix = ''
    for (const byte of bytes) {
      const character = ALPHABET.at(byte % ALPHABET.length)
      if (character === undefined) throw new Error('ID alphabet lookup failed')
      suffix += character
    }
    return `${prefix}_${String(timestamp)}${suffix}`
  }
}
