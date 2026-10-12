import { useParams, useNavigate } from 'react-router-dom'
import { ExecutionResultView } from '@/pages/chat/ExecutionResultView'
import { ROUTES } from '@/lib/constants'

/** 执行结果页；任务与执行 ID 都取自路由，任一缺失即不渲染。 */
export function ExecutionResultPage() {
  const { id, eid } = useParams<{ id: string; eid: string }>()
  const navigate = useNavigate()

  if (!id || !eid) return null

  return (
    <main className="flex h-dvh bg-background">
      <div className="flex flex-1 flex-col min-w-0 max-w-3xl mx-auto w-full">
        <ExecutionResultView
          taskId={id}
          executionId={eid}
          onBack={() => void navigate(`${ROUTES.TASK_DETAIL.replace(':id', id)}?tab=history`)}
        />
      </div>
    </main>
  )
}
