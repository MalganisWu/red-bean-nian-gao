import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { z } from 'zod'

import {
  createLogger,
  LoggerContext,
  parseLogLevel,
  type LogDestination,
} from '../../src/infra/logger/logger.js'

class MemoryDestination implements LogDestination {
  public readonly lines: string[] = []

  public write(line: string): void {
    this.lines.push(line)
  }
}

const logRecordSchema = z.record(z.string(), z.unknown())

void describe('TypeScript structured logger', () => {
  void it('emits parseable structured JSON with fields', () => {
    const destination = new MemoryDestination()
    const logger = createLogger({
      format: 'json',
      level: 'info',
      destination,
      now: (): Date => new Date('2026-09-04T00:00:00.000Z'),
    })

    logger.info('hello', { key: 'value' })

    const parsed: unknown = JSON.parse(destination.lines[0] ?? '')
    const record = logRecordSchema.parse(parsed)
    assert.equal(record['time'], '2026-09-04T00:00:00.000Z')
    assert.equal(record['level'], 'INFO')
    assert.equal(record['msg'], 'hello')
    assert.equal(record['key'], 'value')
  })

  void it('serializes Error diagnostics instead of dropping non-enumerable fields', () => {
    const destination = new MemoryDestination()
    const logger = createLogger({ format: 'json', level: 'info', destination })
    const cause = new Error('database unavailable')

    logger.error('agent run failed', { error: new Error('runtime failed', { cause }) })

    const parsed: unknown = JSON.parse(destination.lines[0] ?? '')
    const record = logRecordSchema.parse(parsed)
    const error = logRecordSchema.parse(record['error'])
    const serializedCause = logRecordSchema.parse(error['cause'])
    assert.equal(error['name'], 'Error')
    assert.equal(error['message'], 'runtime failed')
    assert.equal(typeof error['stack'], 'string')
    assert.equal(serializedCause['message'], 'database unavailable')
  })

  void it('uses text output for non-json formats', () => {
    const destination = new MemoryDestination()
    const logger = createLogger({ format: 'text', level: 'info', destination })

    logger.info('hello', { key: 'value' })

    assert.match(destination.lines[0] ?? '', /level=INFO/u)
    assert.match(destination.lines[0] ?? '', /msg=hello/u)
    assert.match(destination.lines[0] ?? '', /key=value/u)
  })

  void it('preserves nested causes and aggregate errors in text output', () => {
    const destination = new MemoryDestination()
    const logger = createLogger({ format: 'text', level: 'info', destination })
    const runtimeError = new Error('runtime failed', { cause: new Error('model unavailable') })
    const saveError = new Error('session save failed')

    logger.error('agent run failed', {
      error: new AggregateError([runtimeError, saveError], 'execution and finalization failed'),
    })

    const line = destination.lines[0] ?? ''
    assert.match(line, /execution and finalization failed/u)
    assert.match(line, /runtime failed/u)
    assert.match(line, /model unavailable/u)
    assert.match(line, /session save failed/u)
  })

  void it('filters below the configured level', () => {
    const destination = new MemoryDestination()
    const logger = createLogger({ format: 'text', level: 'warn', destination })

    logger.info('filtered')
    logger.warn('visible')

    assert.equal(destination.lines.length, 1)
    assert.match(destination.lines[0] ?? '', /visible/u)
  })

  void it('parses levels case-insensitively and defaults unknown values to info', () => {
    assert.equal(parseLogLevel('debug'), 'debug')
    assert.equal(parseLogLevel('WARN'), 'warn')
    assert.equal(parseLogLevel('warning'), 'warn')
    assert.equal(parseLogLevel('error'), 'error')
    assert.equal(parseLogLevel('unknown'), 'info')
  })

  void it('returns the default logger outside an async context', () => {
    const defaultLogger = createLogger({ format: 'text', level: 'info' })
    const context = new LoggerContext(defaultLogger)

    assert.equal(context.current(), defaultLogger)
  })

  void it('returns the scoped logger throughout an asynchronous operation', async () => {
    const defaultLogger = createLogger({ format: 'text', level: 'info' })
    const scopedLogger = defaultLogger.child({ request_id: 'request-1' })
    const context = new LoggerContext(defaultLogger)

    await context.run(scopedLogger, async (): Promise<void> => {
      await Promise.resolve()
      assert.equal(context.current(), scopedLogger)
    })
    assert.equal(context.current(), defaultLogger)
  })

  void it('allows the composition root to replace the fallback logger', () => {
    const first = createLogger({ format: 'text', level: 'info' })
    const second = createLogger({ format: 'json', level: 'debug' })
    const context = new LoggerContext(first)

    context.setDefault(second)

    assert.equal(context.current(), second)
  })
})
