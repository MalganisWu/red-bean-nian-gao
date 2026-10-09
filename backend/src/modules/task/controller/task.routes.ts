import { API_ROUTES } from '@red-bean/api-contract'
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'

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
    handler: async (request, reply): Promise<void> => {
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
    },
  })

  // GET /api/task-execution-view-states → TaskController.listViewStates
  // 链路：auth → zod 校验(parseExecutionIds) → controller.listViewStates → 信封
  // 跨任务批量视图状态查询（query 传 execution_ids），独立顶层资源，不作 :id 兄弟段
  bindRoute(server, API_ROUTES.TASK_EXECUTION_VIEW_STATES, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
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
    },
  })

  // GET /api/tasks/:id → TaskController.detail
  // 链路：auth → zod 校验(parseTaskId) → controller.detail → 信封
  bindRoute(server, API_ROUTES.TASK, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
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
    },
  })

  // PUT /api/tasks/:id → TaskController.update
  // 链路：auth → zod 校验(parseTaskId+parseUpdateTaskDto) → controller.update → 信封
  bindRoute(server, API_ROUTES.TASK_UPDATE, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
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
    },
  })

  // DELETE /api/tasks/:id → TaskController.delete
  // 链路：auth → zod 校验(parseTaskId) → controller.delete → 信封
  bindRoute(server, API_ROUTES.TASK_DELETE, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
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
    },
  })

  // GET /api/tasks/:id/executions → TaskController.listExecutions
  // 链路：auth → zod 校验(parseTaskPagination+parseTaskId) → controller.listExecutions → 信封
  bindRoute(server, API_ROUTES.TASK_EXECUTIONS, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
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
    },
  })

  // GET /api/tasks/:id/executions/:eid → TaskController.executionDetail
  // 链路：auth → zod 校验(parseExecutionParams) → controller.executionDetail → 信封
  bindRoute(server, API_ROUTES.TASK_EXECUTION, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
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
    },
  })

  // PUT /api/tasks/:id/executions/:eid/view-state → TaskController.updateViewState
  // 链路：auth → zod 校验(parseExecutionParams+parseExecutionViewStatePatchDto) → controller.updateViewState → 信封
  bindRoute(server, API_ROUTES.TASK_EXECUTION_VIEW_STATE, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
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
    },
  })

  // GET /api/sessions/:id/tasks → TaskController.listBySession
  // 链路：auth → zod 校验(parseTaskId) → controller.listBySession → 信封
  bindRoute(server, API_ROUTES.SESSION_TASKS, {
    auth: authenticate,
    handler: async (request, reply): Promise<void> => {
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
    },
  })
}
