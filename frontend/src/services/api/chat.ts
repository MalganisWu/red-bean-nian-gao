import { API_ROUTES } from '@red-bean/api-contract'
import { apiCall } from './client'
import type { ChatCancelRequest } from '@/types/chat'
import { decodeEmptyEnvelope } from './response-validation'

export async function cancelChat(req: ChatCancelRequest): Promise<void> {
  await apiCall(
    API_ROUTES.CHAT_CANCEL.path,
    { method: 'POST', body: JSON.stringify(req) },
    decodeEmptyEnvelope
  )
}
