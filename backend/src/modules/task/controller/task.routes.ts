import { API_ROUTES } from '@red-bean/api-contract'
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from 'fastify'

import { bindRoute } from './../../../shared/http/bind-route.js'
import { authenticatedPrincipal } from './../../../shared/http/authenticated-request.js'
import { requestAbortSignal } from './../../../shared/http/fastify-http-boundary.js'
import { envelope, sendOk } from './../../../shared/http/response.js'
import type { TaskController } from './task.controller.js'
import {
  parseExecutionIds,
  parseExecutionParams,
  parseExecutionViewStatePatchDto,
  parseTaskId,
  parseTaskPagination,
  parseUpdateTaskDto,
} from './task-request-parser.js'

/**
 * 路由文件承载端点、认证策略、请求解包与成功信封；
 * Controller 保持与 Fastify 解耦的用例签名（入参 DTO + 返回 DTO），此处不内联任何 Schema/serializer。
 * 端点执行链路（Fastify 生命周期，自左向右）：onRequest(全局 Abort+CORS+trace)
 * → preHandler auth → handler zod 校验 → Controller 业务 → 成功信封；
 * 错误由全局 setErrorHandler 统一输出。各端点差异见下方链路指纹注释。
 *
 * @param server - 目标 Fastify 实例，九个端点就地注册到它上面。
 * @param controller - 任务用例控制器；本函数只接线，不持有其生命周期。
 * @param authenticate - 认证前置钩子，所有端点都必须挂上，缺失即等同于开放访问。
 */
export function registerTaskRoutes(
  server: FastifyInstance,
  controller: TaskController,
  authenticate: preHandlerAsyncHookHandler
): void {
  // GET /api/tasks → TaskController.list（游标分页）
  // 链路：auth → zod 校验(parseTaskPagination) → controller.list → 信封
  bindRoute(server, API_ROUTES.TASKS, {
    auth: authenticate,
    handler: (request, reply) => listTasks(controller, request, reply),
  })

  // GET /api/task-execution-view-states → TaskController.listViewStates
  // 链路：auth → zod 校验(parseExecutionIds) → controller.listViewStates → 信封
  // 跨任务批量视图状态查询（query 传 execution_ids），独立顶层资源，不作 :id 兄弟段
  bindRoute(server, API_ROUTES.TASK_EXECUTION_VIEW_STATES, {
    auth: authenticate,
    handler: (request, reply) => listExecutionViewStates(controller, request, reply),
  })

  // GET /api/tasks/:id → TaskController.detail
  // 链路：auth → zod 校验(parseTaskId) → controller.detail → 信封
  bindRoute(server, API_ROUTES.TASK, {
    auth: authenticate,
    handler: (request, reply) => getTaskDetail(controller, request, reply),
  })

  // PUT /api/tasks/:id → TaskController.update
  // 链路：auth → zod 校验(parseTaskId+parseUpdateTaskDto) → controller.update → 信封
  bindRoute(server, API_ROUTES.TASK_UPDATE, {
    auth: authenticate,
    handler: (request, reply) => updateTask(controller, request, reply),
  })

  // DELETE /api/tasks/:id → TaskController.delete
  // 链路：auth → zod 校验(parseTaskId) → controller.delete → 信封
  bindRoute(server, API_ROUTES.TASK_DELETE, {
    auth: authenticate,
    handler: (request, reply) => deleteTask(controller, request, reply),
  })

  // GET /api/tasks/:id/executions → TaskController.listExecutions
  // 链路：auth → zod 校验(parseTaskPagination+parseTaskId) → controller.listExecutions → 信封
  bindRoute(server, API_ROUTES.TASK_EXECUTIONS, {
    auth: authenticate,
    handler: (request, reply) => listTaskExecutions(controller, request, reply),
  })

  // GET /api/tasks/:id/executions/:eid → TaskController.executionDetail
  // 链路：auth → zod 校验(parseExecutionParams) → controller.executionDetail → 信封
  bindRoute(server, API_ROUTES.TASK_EXECUTION, {
    auth: authenticate,
    handler: (request, reply) => getExecutionDetail(controller, request, reply),
  })

  // PUT /api/tasks/:id/executions/:eid/view-state → TaskController.updateViewState
  // 链路：auth → zod 校验(parseExecutionParams+parseExecutionViewStatePatchDto) → controller.updateViewState → 信封
  bindRoute(server, API_ROUTES.TASK_EXECUTION_VIEW_STATE, {
    auth: authenticate,
    handler: (request, reply) => updateExecutionViewState(controller, request, reply),
  })

  // GET /api/sessions/:id/tasks → TaskController.listBySession
  // 链路：auth → zod 校验(parseTaskId) → controller.listBySession → 信封
  bindRoute(server, API_ROUTES.SESSION_TASKS, {
    auth: authenticate,
    handler: (request, reply) => listSessionTasks(controller, request, reply),
  })
}

/**
 * GET /api/tasks：游标分页列出当前用户的任务。
 *
 * @param controller - 任务用例控制器，返回已投影的列表 DTO。
 * @param request - Fastify 请求；用户取自认证 Principal，query 交由 parser 校验。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function listTasks(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { cursor, limit } = parseTaskPagination(request.query)
  await sendOk(
    reply,
    envelope(
      await controller.list(
        authenticatedPrincipal(request).userId,
        cursor,
        limit,
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * GET /api/task-execution-view-states：按 execution_ids 批量取当前用户的视图状态。
 *
 * @param controller - 任务用例控制器，按执行 ID 批量返回视图状态。
 * @param request - Fastify 请求；execution_ids 由 parser 去重并限流，用户取自认证 Principal。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function listExecutionViewStates(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.listViewStates(
        authenticatedPrincipal(request).userId,
        parseExecutionIds(request.query),
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * GET /api/tasks/:id：读取当前用户单个任务的详情。
 *
 * @param controller - 任务用例控制器，越权与不存在都映射为同一条 404。
 * @param request - Fastify 请求；路径参数由 parser 校验，用户取自认证 Principal。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function getTaskDetail(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.detail(
        authenticatedPrincipal(request).userId,
        parseTaskId(request.params),
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * PUT /api/tasks/:id：按 DTO 更新当前用户的单个任务。
 *
 * @param controller - 任务用例控制器，写前校验任务所有权。
 * @param request - Fastify 请求；路径参数与 body 分别由 parser 校验，用户取自认证 Principal。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function updateTask(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.update(
        authenticatedPrincipal(request).userId,
        parseTaskId(request.params),
        parseUpdateTaskDto(request.body),
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * DELETE /api/tasks/:id：软删除当前用户的单个任务。
 *
 * @param controller - 任务用例控制器，只置停用标记、不物理删除。
 * @param request - Fastify 请求；路径参数由 parser 校验，用户取自认证 Principal。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function deleteTask(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.delete(
        authenticatedPrincipal(request).userId,
        parseTaskId(request.params),
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * GET /api/tasks/:id/executions：游标分页列出该任务的执行记录。
 *
 * @param controller - 任务用例控制器，先校验任务归属再分页取执行历史。
 * @param request - Fastify 请求；路径参数与分页 query 由 parser 校验，用户取自认证 Principal。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function listTaskExecutions(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { cursor, limit } = parseTaskPagination(request.query)
  await sendOk(
    reply,
    envelope(
      await controller.listExecutions(
        authenticatedPrincipal(request).userId,
        parseTaskId(request.params),
        cursor,
        limit,
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * GET /api/tasks/:id/executions/:eid：读取单条执行记录的详情。
 *
 * @param controller - 任务用例控制器，任务/执行不存在与越权都收敛到 404。
 * @param request - Fastify 请求；组合路径参数由 parser 校验，用户取自认证 Principal。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function getExecutionDetail(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const params = parseExecutionParams(request.params)
  await sendOk(
    reply,
    envelope(
      await controller.executionDetail(
        authenticatedPrincipal(request).userId,
        params.id,
        params.eid,
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * PUT /api/tasks/:id/executions/:eid/view-state：更新单条执行记录的视图状态。
 *
 * @param controller - 任务用例控制器，按所有权 → 执行存在性 → upsert 顺序校验。
 * @param request - Fastify 请求；路径参数与 PATCH body 由 parser 校验，用户取自认证 Principal。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function updateExecutionViewState(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const params = parseExecutionParams(request.params)
  await sendOk(
    reply,
    envelope(
      await controller.updateViewState(
        authenticatedPrincipal(request).userId,
        params.id,
        params.eid,
        parseExecutionViewStatePatchDto(request.body),
        requestAbortSignal(request)
      )
    )
  )
}

/**
 * GET /api/sessions/:id/tasks：列出某个会话下的全部任务。
 *
 * @param controller - 任务用例控制器，结果同时按用户过滤，越权会话返回空列表。
 * @param request - Fastify 请求；会话 ID 由 parser 校验，用户取自认证 Principal。
 * @param reply - Fastify 响应；成功信封在此写入。
 */
async function listSessionTasks(
  controller: TaskController,
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await sendOk(
    reply,
    envelope(
      await controller.listBySession(
        authenticatedPrincipal(request).userId,
        parseTaskId(request.params),
        requestAbortSignal(request)
      )
    )
  )
}
