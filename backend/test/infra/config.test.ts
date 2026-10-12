import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  loadConfig,
  parseConfig,
  parseDurationMilliseconds,
} from '../../src/infra/config/config.js'

function validRawConfig(): Record<string, unknown> {
  return {
    database: { url: 'postgres://user:pass@host/db' },
    redis: { url: 'redis://host:6379/0' },
    jwt: { secret: 'actual-secret-key' },
    minio: {
      endpoint: 'minio:9000',
      access_key: 'admin',
      secret_key: 'password123',
    },
  }
}

function replaceSectionField(
  config: Record<string, unknown>,
  section: string,
  key: string,
  value: unknown
): void {
  const original = config[section]
  if (typeof original !== 'object' || original === null || Array.isArray(original)) {
    throw new Error(`test fixture section ${section} must be an object`)
  }
  config[section] = { ...original, [key]: value }
}

void describe('TypeScript backend configuration', () => {
  void it('loads config.yaml then applies environment values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rbng-config-'))
    try {
      // 本地单源之后不再有 config.local.yaml 覆盖层，链路由三段收敛为两段：
      // config.yaml（入库默认值） → process.env（.env.local 在入口注入）。
      await writeFile(
        join(directory, 'config.yaml'),
        `server:\n  port: "8081"\ndatabase:\n  url: postgres://base:pass@host/base\nredis:\n  url: redis://host:6379/0\njwt:\n  secret: base-secret\nminio:\n  endpoint: minio:9000\n  access_key: base-access\n  secret_key: base-secret\nllm:\n  model: base-model\n`,
        'utf8'
      )

      const config = await loadConfig({
        directory,
        environment: {
          DATABASE_URL: 'postgres://env:pass@host/env',
          LLM_MODEL: 'environment-model',
          SERVER_PORT: '8082',
          LLM_BASE_URL: 'https://env.example/v1',
        },
      })

      // YAML 提供基线，环境变量逐字段覆盖；未被覆盖的字段保持 YAML 值
      assert.equal(config.server.port, '8082')
      assert.equal(config.database.url, 'postgres://env:pass@host/env')
      assert.equal(config.llm.baseUrl, 'https://env.example/v1')
      assert.equal(config.llm.model, 'environment-model')
      assert.equal(config.redis.url, 'redis://host:6379/0')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  void it('accepts a minimal config.yaml and lets environment variables supply the rest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rbng-config-'))
    try {
      // 单源的直接后果：本地只需一个 .env.local 就能补齐全部字段，
      // 因此 config.yaml 允许是「只有非密默认值」的薄基线。
      await writeFile(join(directory, 'config.yaml'), 'server:\n  env: local\n', 'utf8')
      const config = await loadConfig({
        directory,
        environment: {
          DATABASE_URL: 'postgres://admin:pw@localhost:5432/red_bean',
          REDIS_URL: 'redis://:pw@localhost:6379/0',
          JWT_SECRET: 'local-dev-jwt-secret-0123456789abcdef',
          MINIO_ENDPOINT: 'localhost:9000',
          MINIO_ACCESS_KEY: 'minioadmin',
          MINIO_SECRET_KEY: 'minio-pw',
        },
      })
      assert.equal(config.database.url, 'postgres://admin:pw@localhost:5432/red_bean')
      assert.equal(config.redis.url, 'redis://:pw@localhost:6379/0')
      assert.equal(config.minio.accessKey, 'minioadmin')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  void it('requires a valid config.yaml', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rbng-config-'))
    try {
      await writeFile(
        join(directory, 'config.yaml'),
        `database:\n  url: postgres://base:pass@host/base\nredis:\n  url: redis://host:6379/0\njwt:\n  secret: base-secret\nminio:\n  endpoint: minio:9000\n  access_key: base-access\n  secret_key: base-secret\n`,
        'utf8'
      )
      const config = await loadConfig({ directory, environment: {} })
      assert.equal(config.database.url, 'postgres://base:pass@host/base')

      await rm(join(directory, 'config.yaml'))
      await assert.rejects(loadConfig({ directory, environment: {} }), /读取 config\.yaml 失败/u)

      await writeFile(join(directory, 'config.yaml'), 'database: [invalid', 'utf8')
      await assert.rejects(loadConfig({ directory, environment: {} }), /解析 config\.yaml 失败/u)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  void it('applies the documented defaults', () => {
    const config = parseConfig(validRawConfig(), {})
    assert.deepEqual(config.server, {
      host: '0.0.0.0',
      port: '8080',
      env: 'local',
      logFormat: 'text',
      logLevel: 'info',
    })
    assert.equal(config.llm.model, 'gpt-4')
    assert.equal(config.minio.bucket, 'red-bean-nian-gao')
    assert.deepEqual(config.scheduledTask, {
      maxRetries: 3,
      retryInterval: '5m',
      timezone: 'Asia/Shanghai',
      scanInterval: '1m',
      batchSize: 100,
      maxConcurrent: 4,
      executionTimeout: '15m',
    })
    assert.deepEqual(config.observability, {
      exporter: 'structured',
      serviceName: 'red-bean-nian-gao',
      sampleRatio: 1,
    })
  })

  void it('uses environment variables as the highest precedence', () => {
    const config = parseConfig(validRawConfig(), {
      DATABASE_URL: 'postgres://env:pass@host/env',
      DATABASE_AUTO_MIGRATE: 'true',
      JWT_SECRET: 'environment-secret',
      SERVER_PORT: '9090',
      OBSERVABILITY_EXPORTER: 'otlp',
      OTEL_SERVICE_NAME: 'env-service',
      OTEL_TRACES_SAMPLER_ARG: '0.25',
    })
    assert.equal(config.database.url, 'postgres://env:pass@host/env')
    assert.equal(config.database.autoMigrate, true)
    assert.equal(config.jwt.secret, 'environment-secret')
    assert.equal(config.server.port, '9090')
    assert.equal(config.observability.exporter, 'otlp')
    assert.equal(config.observability.serviceName, 'env-service')
    assert.equal(config.observability.sampleRatio, 0.25)
  })

  void it('rejects missing values, placeholders, and unsafe production settings', () => {
    const missingDatabase = validRawConfig()
    missingDatabase['database'] = { url: '' }
    assert.throws(() => parseConfig(missingDatabase, {}), /database\.url/)

    const placeholder = validRawConfig()
    placeholder['jwt'] = { secret: 'CHANGE_ME' }
    assert.throws(() => parseConfig(placeholder, {}), /jwt\.secret/)

    for (const [section, key] of [
      ['redis', 'url'],
      ['minio', 'endpoint'],
      ['minio', 'access_key'],
      ['minio', 'secret_key'],
    ] as const) {
      const missing = validRawConfig()
      replaceSectionField(missing, section, key, '')
      assert.throws(() => parseConfig(missing, {}), new RegExp(`${section}\\.${key}`))
    }

    for (const [section, key] of [
      ['database', 'url'],
      ['redis', 'url'],
      ['minio', 'access_key'],
      ['minio', 'secret_key'],
    ] as const) {
      const withPlaceholder = validRawConfig()
      replaceSectionField(withPlaceholder, section, key, 'CHANGE_ME')
      assert.throws(() => parseConfig(withPlaceholder, {}), /\u793a\u4f8b\u503c/)
    }

    const production = validRawConfig()
    production['server'] = { env: 'production' }
    production['database'] = {
      url: 'postgres://user:pass@host/db',
      auto_migrate: true,
    }
    assert.throws(() => parseConfig(production, {}), /auto_migrate/)

    const weakSecret = validRawConfig()
    weakSecret['server'] = { env: 'prod' }
    assert.throws(() => parseConfig(weakSecret, {}), /32/)
  })

  void it('rejects invalid scheduler and observability values', () => {
    const invalidDuration = validRawConfig()
    invalidDuration['scheduled_task'] = { retry_interval: 'tomorrow' }
    assert.throws(() => parseConfig(invalidDuration, {}), /retry_interval/)

    const invalidTimezone = validRawConfig()
    invalidTimezone['scheduled_task'] = { timezone: 'Not/AZone' }
    assert.throws(() => parseConfig(invalidTimezone, {}), /timezone/)

    const explicitZero = validRawConfig()
    explicitZero['observability'] = { sample_ratio: 0 }
    assert.throws(() => parseConfig(explicitZero, {}), /sample_ratio/)

    const invalidExporter = validRawConfig()
    invalidExporter['observability'] = { exporter: 'zipkin' }
    assert.throws(() => parseConfig(invalidExporter, {}), /exporter/)

    for (const [key, value] of [
      ['max_retries', -1],
      ['batch_size', -1],
      ['max_concurrent', -1],
      ['scan_interval', 'invalid'],
      ['execution_timeout', '-1s'],
    ] as const) {
      const invalidScheduler = validRawConfig()
      invalidScheduler['scheduled_task'] = { [key]: value }
      assert.throws(() => parseConfig(invalidScheduler, {}), new RegExp(key))
    }

    const emptyServiceName = validRawConfig()
    emptyServiceName['observability'] = { service_name: ' ' }
    assert.throws(() => parseConfig(emptyServiceName, {}), /service_name/)

    const excessiveSampleRatio = validRawConfig()
    excessiveSampleRatio['observability'] = { sample_ratio: 1.1 }
    assert.throws(() => parseConfig(excessiveSampleRatio, {}), /sample_ratio/)
  })

  void it('parses compound positive durations', () => {
    assert.equal(parseDurationMilliseconds('1h30m5.5s'), 5_405_500)
    assert.throws(() => parseDurationMilliseconds('0s'), /greater than zero/)
    assert.throws(() => parseDurationMilliseconds('1 day'), /duration/)
  })
})
