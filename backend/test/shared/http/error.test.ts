import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  AppError,
  errorResponse,
  internalError,
  loggedInternalError,
  notFoundError,
  payloadTooLargeError,
  rateLimitError,
  validationError,
} from '../../../src/shared/http/error-mapper.js'

void describe('TypeScript backend application errors', () => {
  void it('preserves stable business and HTTP codes', () => {
    const error = validationError('字段不能为空')
    assert.equal(error.code, 4001)
    assert.equal(error.httpStatus, 400)
    assert.equal(error.message, '字段不能为空')
    assert.equal(notFoundError('不存在').code, 4004)
    assert.equal(rateLimitError('稍后重试').httpStatus, 429)
    assert.equal(payloadTooLargeError('过大').httpStatus, 413)
  })

  void it('never exposes an internal cause in the response', () => {
    const cause = new Error('database password leaked')
    const error = loggedInternalError('load failed', cause)
    assert.equal(error.cause, cause)
    assert.equal(error.logMessage, 'load failed')
    assert.deepEqual(errorResponse(error), {
      status: 500,
      body: { code: 5000, message: '服务器内部错误', data: null },
    })
    assert.deepEqual(errorResponse(cause), errorResponse(internalError()))
  })

  void it('returns known safe errors unchanged', () => {
    const error = new AppError({
      httpStatus: 409,
      code: 4009,
      message: '资源冲突',
    })
    assert.deepEqual(errorResponse(error), {
      status: 409,
      body: { code: 4009, message: '资源冲突', data: null },
    })
  })
})
