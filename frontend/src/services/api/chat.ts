import { API_ROUTES } from '@red-bean/api-contract'
import { apiCall } from './client'
import type { ChatCancelRequest } from '@/types/chat'
import { decodeEmptyEnvelope } from './response-validation'

/**
 * 请求后端取消一轮正在运行的对话；只做服务端通知，本地流的中止由调用方负责。
 *
 * @param req - 取消请求体，携带目标 request_id；服务端据此定位并终止运行中的请求。
 */
export async function cancelChat(req: ChatCancelRequest): Promise<void> {
  await apiCall(
    API_ROUTES.CHAT_CANCEL.path,
    { method: 'POST', body: JSON.stringify(req) },
    decodeEmptyEnvelope
  )
}
