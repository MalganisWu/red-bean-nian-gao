import { API_ROUTES } from '@red-bean/api-contract'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify'

import { bindRoute } from '../../../shared/http/bind-route.js'
import { authenticatedPrincipal } from '../../../shared/http/authenticated-request.js'
import { requestAbortSignal } from '../../../shared/http/fastify-http-boundary.js'
import { validationError } from '../../../shared/http/error-mapper.js'
import { envelope, sendOk } from '../../../shared/http/response.js'
import type { UploadObjectCommand } from '../service/application/storage-service.js'
import type { StorageController } from './storage.controller.js'
import { parseObjectPath, parsePresignRequest } from './storage-request-parser.js'

/** 单次上传的字节上限，20 MiB；同时交给 multipart 解析器与解析后的二次校验使用。 */
const MAX_UPLOAD_BYTES = 20 << 20

/**
 * 路由文件承载端点、认证策略、请求解包（含 multipart）与成功信封；
 * Controller 保持与 Fastify 解耦的用例签名（入参 DTO + 返回 DTO），下载流在此投影为 HTTP 响应流。
 * 端点执行链路（Fastify 生命周期，自左向右）：onRequest(全局 Abort+CORS+trace)
 * → preHandler auth → handler zod 校验 → Controller 业务 → 信封 / 文件字节流；
 * 错误由全局 setErrorHandler 统一输出。各端点差异见下方链路指纹注释。
 *
 * @param server - 承载路由的 Fastify 实例；路径一律取自 `API_ROUTES`，不手写路径字面量
 * @param controller - 已组装的用例控制器；路由只做解包与信封投影，不含业务规则
 * @param authenticate - 认证前置处理器；五个端点全部要求已登录，此处不做逐端点差异化
 */
export function registerStorageRoutes(
  server: FastifyInstance,
  controller: StorageController,
  authenticate: preHandlerAsyncHookHandler
): void {
  // POST /api/storage/upload → StorageController.upload → StorageService.upload
  // 链路：auth → multipart 解析(≤20MiB) → controller.upload → 信封
  bindRoute(server, API_ROUTES.STORAGE_UPLOAD, {
    auth: authenticate,
    handler: (request, reply) => uploadObject(controller, request, reply),
  })

  // GET /api/storage/download/* → StorageController.download → StorageService.download
  // 链路：auth → zod 校验(parseObjectPath) → controller.download → 文件字节流
  // 通配 `*` 为 Fastify splat，对象 key 可含斜杠；参数键为 `'*'`（见 api-contract objectPathSchema）
  bindRoute(server, API_ROUTES.STORAGE_DOWNLOAD, {
    auth: authenticate,
    handler: (request, reply) => downloadObject(controller, request, reply),
  })

  // DELETE /api/storage/objects/* → StorageController.delete → StorageService.delete
  // 链路：auth → zod 校验(parseObjectPath) → controller.delete → 信封
  bindRoute(server, API_ROUTES.STORAGE_OBJECTS, {
    auth: authenticate,
    handler: (request, reply) => deleteObject(controller, request, reply),
  })

  // POST /api/storage/presign/get → StorageController.presignGet（预签名下载）
  // 链路：auth → zod 校验(parsePresignRequest) → controller.presignGet → 信封
  bindRoute(server, API_ROUTES.STORAGE_PRESIGN_GET, {
    auth: authenticate,
    handler: (request, reply) => presignObjectGet(controller, request, reply),
  })

  // POST /api/storage/presign/put → StorageController.presignPut（预签名上传）
  // 链路：auth → zod 校验(parsePresignRequest) → controller.presignPut → 信封
  bindRoute(server, API_ROUTES.STORAGE_PRESIGN_PUT, {
    auth: authenticate,
    handler: (request, reply) => presignObjectPut(controller, request, reply),
  })
}

/**
 * POST /api/storage/upload：解析 multipart 文件并写入对象存储。
 *
 * @param controller - 已组装的用例控制器，上传业务由它执行
 * @param request - Fastify 请求对象，文件从 multipart 体中读取并在此校验大小
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function uploadObject(
  controller: StorageController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const file = await parseUploadFile(request)
  await sendOk(
    reply,
    envelope(
      await controller.upload(
        { userId: authenticatedPrincipal(request).userId, ...file },
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * GET /api/storage/download/*：取回对象并把字节流投影为 HTTP 响应。
 *
 * 这里不套成功信封，直接把对象字节流写进响应；流的所有权在 `reply.send` 之后交给 Fastify，
 * 因此不在此关闭，断连由取消信号传导到底层销毁。
 *
 * @param controller - 已组装的用例控制器，返回未消费的下载流与元信息
 * @param request - Fastify 请求对象，对象 key 从通配路径参数解析
 * @param reply - Fastify 响应对象，内容类型、长度与 etag 由元信息回填后直接发送字节流
 */
async function downloadObject(
  controller: StorageController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const download = await controller.download(
    authenticatedPrincipal(request).userId,
    parseObjectPath(request.params),
    requestAbortSignal(request)
  )
  reply.header('content-type', download.info.contentType)
  reply.header('content-length', String(download.info.size))
  reply.header('etag', download.info.etag)
  await reply.status(200).send(download.body)
}

/**
 * DELETE /api/storage/objects/*：删除当前用户拥有的对象。
 *
 * @param controller - 已组装的用例控制器，删除业务由它执行
 * @param request - Fastify 请求对象，对象 key 从通配路径参数解析
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function deleteObject(
  controller: StorageController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.delete(
        authenticatedPrincipal(request).userId,
        parseObjectPath(request.params),
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * POST /api/storage/presign/get：签发下载预签名 URL。
 *
 * @param controller - 已组装的用例控制器，签名由它委托应用层完成
 * @param request - Fastify 请求对象，有效期等参数从 `request.body` 解析
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function presignObjectGet(
  controller: StorageController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.presignGet(
        {
          userId: authenticatedPrincipal(request).userId,
          ...parsePresignRequest(request.body),
        },
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * POST /api/storage/presign/put：签发上传预签名 URL。
 *
 * @param controller - 已组装的用例控制器，签名由它委托应用层完成
 * @param request - Fastify 请求对象，有效期等参数从 `request.body` 解析
 * @param reply - Fastify 响应对象，成功信封由 `sendOk` 写出
 */
async function presignObjectPut(
  controller: StorageController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.presignPut(
        {
          userId: authenticatedPrincipal(request).userId,
          ...parsePresignRequest(request.body),
        },
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * 读取并校验 multipart 上传文件；对象归属与 size 限制属于传输层约束。
 *
 * 三重判据都会落到同一条 400：`request.file` 因超限直接抛出、读取过程中抛错、
 * 以及读取完成但 `truncated`（或长度超限）——任一都说明文件不完整，不能交给应用层。
 * 内容类型缺失时回退到 `application/octet-stream`，保证下游始终拿得到合法值。
 *
 * @param request - Fastify 请求对象，multipart 体在此解析并受 `MAX_UPLOAD_BYTES` 限制
 * @returns 上传命令中除归属用户外的部分：文件名、字节内容与内容类型
 */
async function parseUploadFile(
  request: FastifyRequest
): Promise<Omit<UploadObjectCommand, 'userId'>> {
  let file: Awaited<ReturnType<FastifyRequest['file']>>
  try {
    file = await request.file({ limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } })
  } catch {
    throw validationError('上传文件不能超过 20 MiB')
  }
  if (file === undefined) throw validationError('缺少上传文件')

  let contents: Buffer
  try {
    contents = await file.toBuffer()
  } catch {
    throw validationError('上传文件不能超过 20 MiB')
  }
  if (file.file.truncated || contents.length > MAX_UPLOAD_BYTES) {
    throw validationError('上传文件不能超过 20 MiB')
  }
  return {
    filename: file.filename,
    contents,
    contentType: file.mimetype || 'application/octet-stream',
  }
}
