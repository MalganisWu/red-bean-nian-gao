import assert from 'node:assert/strict'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { PassThrough, Readable } from 'node:stream'
import { describe, it } from 'node:test'

import type { IdGenerator } from '../../../../src/shared/id/id-generator.js'

import { createHttpServer } from '../../../../src/shared/http/fastify-http-boundary.js'
import { registerStorageRoutes } from '../../../../src/modules/storage/http-api.js'
import { StorageService } from '../../../../src/modules/storage/service/application/storage-service.js'
import { bindDownloadStreamToAbort } from '../../../../src/modules/storage/service/object-storage/download-stream-lifecycle.js'
import type { AuthServicePort } from '../../../../src/modules/identity/service/authentication/port/auth-service.port.js'
import type {
  ObjectStorage,
  PresignInput,
  UploadInput,
} from '../../../../src/modules/storage/service/object-storage/port/object-storage.js'
import type { ObjectInfo } from '../../../../src/modules/storage/service/application/model/object-result.js'

class FixedIdGenerator implements IdGenerator {
  public generate(prefix: string): string {
    return `${prefix}_test`
  }
}

class StorageAuth implements AuthServicePort {
  public login(): Promise<string> {
    return Promise.resolve('unused')
  }

  public logout(): Promise<void> {
    return Promise.resolve()
  }

  public validateToken(token: string): Promise<string> {
    return token === 'valid' ? Promise.resolve('USER_1') : Promise.reject(new Error('invalid'))
  }

  public refreshToken(): Promise<string> {
    return Promise.resolve('unused')
  }
}

class RecordingObjectStorage implements ObjectStorage {
  public uploadKey = ''
  public deleteKey = ''
  public getKey = ''
  public putKey = ''
  public downloadKey = ''
  public statKey = ''

  public ensureBucket(): Promise<void> {
    return Promise.resolve()
  }

  public async upload(input: UploadInput, signal: AbortSignal): Promise<ObjectInfo> {
    signal.throwIfAborted()
    this.uploadKey = input.key
    let size = 0
    for await (const chunk of input.body) {
      size += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
    }
    return {
      key: input.key,
      size,
      contentType: input.contentType,
      etag: 'etag',
      lastModified: new Date('2026-09-04T00:00:00.000Z'),
    }
  }

  public download(
    key: string,
    signal: AbortSignal
  ): Promise<{ readonly body: Readable; readonly info: ObjectInfo }> {
    signal.throwIfAborted()
    this.downloadKey = key
    return Promise.resolve({
      body: Readable.from(['ok']),
      info: {
        key,
        size: 2,
        contentType: 'text/plain',
        etag: 'etag',
        lastModified: new Date('2026-09-04T00:00:00.000Z'),
      },
    })
  }

  public delete(key: string): Promise<void> {
    this.deleteKey = key
    return Promise.resolve()
  }

  public stat(key: string): Promise<ObjectInfo | undefined> {
    // 默认 fake 语义：对象存在（返回与 key 对应的元数据）；"不存在"场景由 MissingObjectStorage 覆盖。
    this.statKey = key
    return Promise.resolve({
      key,
      size: 2,
      contentType: 'text/plain',
      etag: 'etag',
      lastModified: new Date('2026-09-04T00:00:00.000Z'),
    })
  }

  public presignGet(input: PresignInput): Promise<string> {
    this.getKey = input.key
    return Promise.resolve('https://example.test/get')
  }

  public presignPut(input: PresignInput): Promise<string> {
    this.putKey = input.key
    return Promise.resolve('https://example.test/put')
  }
}

class MissingObjectStorage extends RecordingObjectStorage {
  public override stat(): Promise<ObjectInfo | undefined> {
    return Promise.resolve(undefined)
  }
}

class DisconnectingObjectStorage extends RecordingObjectStorage {
  public readonly body = new PassThrough({ autoDestroy: false })
  public downloadSignal: AbortSignal | undefined

  public override download(
    key: string,
    signal: AbortSignal
  ): Promise<{ readonly body: Readable; readonly info: ObjectInfo }> {
    this.downloadSignal = signal
    bindDownloadStreamToAbort(this.body, signal)
    this.body.write('partial')
    return Promise.resolve({
      body: this.body,
      info: {
        key,
        size: 1_000,
        contentType: 'application/octet-stream',
        etag: 'etag',
        lastModified: new Date('2026-09-04T00:00:00.000Z'),
      },
    })
  }
}

async function buildServer(storage: ObjectStorage) {
  const server = createHttpServer({ idGenerator: new FixedIdGenerator() })
  registerStorageRoutes(server, {
    storageService: new StorageService(storage, (): Date => new Date('2026-09-04T01:02:03.456Z')),
    authService: new StorageAuth(),
  })
  await server.ready()
  return server
}

void describe('Fastify storage route parity', () => {
  void it('splat 通配保留含斜杠对象 key，并拒绝空 key、无尾斜杠与 .. 段（含编码绕过）', async () => {
    const storage = new RecordingObjectStorage()
    const server = await buildServer(storage)

    // 多级斜杠 key 完整透传（splat 语义，:param 无法匹配 /）
    const nested = await server.inject({
      method: 'GET',
      url: '/api/storage/download/uploads/USER_1/arch/2026/q1/report.txt',
      headers: { authorization: 'Bearer valid' },
    })
    assert.equal(nested.statusCode, 200)
    assert.equal(storage.downloadKey, 'uploads/USER_1/arch/2026/q1/report.txt')

    // 空 splat（download/ 后无任何内容）→ 路由仍匹配，objectPathSchema 非空校验拒绝
    const empty = await server.inject({
      method: 'GET',
      url: '/api/storage/download/',
      headers: { authorization: 'Bearer valid' },
    })
    assert.equal(empty.statusCode, 400)

    // 无尾斜杠 → splat 不匹配，404
    const noTrailing = await server.inject({
      method: 'GET',
      url: '/api/storage/download',
      headers: { authorization: 'Bearer valid' },
    })
    assert.equal(noTrailing.statusCode, 404)

    // '..' 段（含 %2E%2E 编码形式）在路由匹配前被 Fastify 解码并归一化 → 404，schema 不可见；
    // objectPathSchema 的 '..' 拒绝属于纵深防御（防绕过路由直接调用 parseObjectPath），
    // 其行为由 api-contract validators 契约测试直接覆盖。
    const traversal = await server.inject({
      method: 'DELETE',
      url: '/api/storage/objects/../secret.txt',
      headers: { authorization: 'Bearer valid' },
    })
    assert.equal(traversal.statusCode, 404)
    assert.equal(storage.deleteKey, '')

    const encodedTraversal = await server.inject({
      method: 'DELETE',
      url: '/api/storage/objects/%2E%2E/secret.txt',
      headers: { authorization: 'Bearer valid' },
    })
    assert.equal(encodedTraversal.statusCode, 404)
    assert.equal(storage.deleteKey, '')
    await server.close()
  })

  void it('对象不存在时下载返回 404 而非 500，且不触碰下载流', async () => {
    const storage = new MissingObjectStorage()
    const server = await buildServer(storage)

    const missing = await server.inject({
      method: 'GET',
      url: '/api/storage/download/uploads/USER_1/a.txt',
      headers: { authorization: 'Bearer valid' },
    })
    assert.equal(missing.statusCode, 404)
    assert.deepEqual(missing.json(), {
      code: 4004,
      message: '对象不存在',
      data: null,
    })
    assert.equal(storage.downloadKey, '')
    await server.close()
  })

  void it('requires authentication and enforces object ownership', async () => {
    const storage = new RecordingObjectStorage()
    const server = await buildServer(storage)

    const anonymous = await server.inject({
      method: 'GET',
      url: '/api/storage/download/uploads/USER_1/a.txt',
    })
    assert.equal(anonymous.statusCode, 401)

    const foreign = await server.inject({
      method: 'DELETE',
      url: '/api/storage/objects/uploads/USER_2/a.txt',
      headers: { authorization: 'Bearer valid' },
    })
    assert.equal(foreign.statusCode, 404)

    const owned = await server.inject({
      method: 'DELETE',
      url: '/api/storage/objects/uploads/USER_1/a.txt',
      headers: { authorization: 'Bearer valid' },
    })
    assert.equal(owned.statusCode, 200)
    assert.equal(storage.deleteKey, 'uploads/USER_1/a.txt')
    await server.close()
  })

  void it('prefixes uploaded files with the authenticated user', async () => {
    const storage = new RecordingObjectStorage()
    const server = await buildServer(storage)
    const boundary = 'rbng-boundary'
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Note.TXT"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--${boundary}--\r\n`
    )

    const response = await server.inject({
      method: 'POST',
      url: '/api/storage/upload',
      headers: {
        authorization: 'Bearer valid',
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    })

    assert.equal(response.statusCode, 200)
    assert.equal(storage.uploadKey, 'uploads/USER_1/1788483723456.txt')
    assert.deepEqual(response.json(), {
      code: 200,
      data: { key: storage.uploadKey, size: 5, content_type: 'text/plain', etag: 'etag' },
    })
    await server.close()
  })

  void it('rejects presign lifetimes over one hour before calling storage', async () => {
    const storage = new RecordingObjectStorage()
    const server = await buildServer(storage)
    const response = await server.inject({
      method: 'POST',
      url: '/api/storage/presign/get',
      headers: { authorization: 'Bearer valid' },
      payload: { key: 'uploads/USER_1/a.txt', expires: 3_601 },
    })

    assert.equal(response.statusCode, 400)
    assert.equal(storage.getKey, '')
    await server.close()
  })

  void it('defaults presign lifetime to 15 minutes and hides foreign keys', async () => {
    const storage = new RecordingObjectStorage()
    const server = await buildServer(storage)
    const valid = await server.inject({
      method: 'POST',
      url: '/api/storage/presign/put',
      headers: { authorization: 'Bearer valid' },
      payload: { key: 'uploads/USER_1/a.txt' },
    })
    assert.equal(valid.statusCode, 200)
    assert.deepEqual(valid.json(), {
      code: 200,
      data: { url: 'https://example.test/put', expires_in: 900 },
    })

    const foreign = await server.inject({
      method: 'POST',
      url: '/api/storage/presign/get',
      headers: { authorization: 'Bearer valid' },
      payload: { key: 'uploads/USER_2/a.txt' },
    })
    assert.equal(foreign.statusCode, 404)
    await server.close()
  })

  void it('真实 HTTP 下载断连会取消请求并销毁底层响应流', async () => {
    const storage = new DisconnectingObjectStorage()
    const server = await buildServer(storage)
    await server.listen({ host: '127.0.0.1', port: 0 })
    const address = server.server.address()
    if (address === null || typeof address === 'string') throw new Error('expected TCP address')

    let response: IncomingMessage | undefined
    try {
      const activeResponse = await new Promise<IncomingMessage>((resolve, reject): void => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: address.port,
            path: '/api/storage/download/uploads/USER_1/a.bin',
            method: 'GET',
            headers: { authorization: 'Bearer valid' },
          },
          resolve
        )
        request.once('error', reject)
        request.end()
      })
      response = activeResponse
      activeResponse.destroy()
      const signal = storage.downloadSignal
      if (signal === undefined) throw new Error('download signal was not captured')
      await waitForAbort(signal)
      assert.equal(storage.body.destroyed, true)
    } finally {
      response?.destroy()
      await server.close()
    }
  })
})

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve): void => {
    signal.addEventListener('abort', (): void => resolve(), { once: true })
  })
}
