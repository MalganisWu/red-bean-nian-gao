import { useEffect } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/Button'
import { Toaster } from '@/components/Sonner'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

const PREVIEW_IDS = {
  notice: 'design-system-toast-notice',
  success: 'design-system-toast-success',
  error: 'design-system-toast-error',
}

function showNoticeToast(): void {
  toast('草稿已保存', {
    id: PREVIEW_IDS.notice,
    description: '内容会在下次打开时恢复。',
    duration: Infinity,
    action: { label: '撤销', onClick: () => undefined },
  })
}

function showSuccessToast(): void {
  toast.success('保存成功', {
    id: PREVIEW_IDS.success,
    description: '任务设置已更新。',
    duration: Infinity,
    action: { label: '关闭', onClick: () => toast.dismiss(PREVIEW_IDS.success) },
  })
}

function showErrorToast(): void {
  toast.error('执行失败', {
    id: PREVIEW_IDS.error,
    description: '连接失败，请检查后重试。',
    duration: Infinity,
    action: { label: '查看', onClick: () => undefined },
  })
}

export function ToastPage(): React.ReactElement {
  useEffect(() => {
    const previewTimer = window.setTimeout(() => {
      showNoticeToast()
      showSuccessToast()
      showErrorToast()
    }, 400)

    return () => {
      window.clearTimeout(previewTimer)
      toast.dismiss(PREVIEW_IDS.notice)
      toast.dismiss(PREVIEW_IDS.success)
      toast.dismiss(PREVIEW_IDS.error)
    }
  }, [])

  return (
    <div className="conversation-showcase">
      <Toaster position="bottom-right" visibleToasts={4} expand />

      <SpecPageHeader
        title="通知 · Toast"
        description="普通通知保持灰阶；成功绿与失败红只用于状态图标，操作使用无填充文字。"
        note="进入页面会展示普通、成功和失败三种真实 Toast，按钮可重新触发。"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Notice / success / error</h3>
        <div className="flex flex-wrap gap-3 border-y border-border-strong py-5">
          <Button variant="outline" onClick={showNoticeToast}>
            预览普通通知
          </Button>
          <Button variant="outline" onClick={showSuccessToast}>
            预览成功通知
          </Button>
          <Button variant="outline" onClick={showErrorToast}>
            预览失败通知
          </Button>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>Notice</strong>
            <p>普通通知不显示状态色，操作仍为无填充文字。</p>
          </div>
          <div>
            <strong>Success</strong>
            <p>绿色状态图标 + 明确成功文字，不使用绿色容器。</p>
          </div>
          <div>
            <strong>Error</strong>
            <p>鲜红状态图标 + 可行动错误说明，不使用红色容器。</p>
          </div>
          <div>
            <strong>Action</strong>
            <p>关闭、查看、撤销均使用无填充豆沙红文字。</p>
          </div>
          <div>
            <strong>Layer</strong>
            <p>1px strong border、10px 圆角、唯一浮层阴影。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
