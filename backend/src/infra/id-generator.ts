import { randomBytes } from 'node:crypto'

import type { IdGenerator } from '../shared/id/id-generator.js'

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const SUFFIX_LENGTH = 8

export type MillisecondClock = () => number
export type RandomByteSource = (size: number) => Uint8Array

/** 生成与既有产品 wire 格式一致的不透明 ID。 */
export class TimestampIdGenerator implements IdGenerator {
  readonly #clock: MillisecondClock
  readonly #randomBytes: RandomByteSource

  public constructor(
    clock: MillisecondClock = Date.now,
    randomByteSource: RandomByteSource = randomBytes
  ) {
    this.#clock = clock
    this.#randomBytes = randomByteSource
  }

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
