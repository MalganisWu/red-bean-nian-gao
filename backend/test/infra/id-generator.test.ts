import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TimestampIdGenerator } from '../../src/infra/id-generator.js'

void describe('timestamp ID generator', () => {
  void it('keeps the prefix, millisecond timestamp, and eight-character suffix', () => {
    const generator = new TimestampIdGenerator(
      (): number => 1_788_500_000_123,
      (): Uint8Array => Uint8Array.from([0, 1, 2, 3, 26, 27, 28, 29])
    )

    assert.equal(generator.generate('SESS'), 'SESS_1788500000123abcd0123')
  })
})
