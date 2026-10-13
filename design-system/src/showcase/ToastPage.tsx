import { useEffect } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/Button'
import { Toaster } from '@/components/Sonner'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

/**
 * 三种预览通知的固定 id。
 *
 * 固定 id 让重复触发替换同一条通知而不是层层堆叠；卸载时也用同一组 id
 * 精确关闭，避免误伤页面上的其它 Toast。
 */
const PREVIEW_IDS = {
  notice: 'design-system-toast-notice',
  success: 'design-system-toast-success',
  error: 'design-system-toast-error',
}

/**
 * 展示普通通知：灰阶样式，无状态色，操作为「撤销」。
 *
 * `duration: Infinity` 让它常驻，方便在展示页慢慢看；关闭交给操作或页面卸载。
 */
function showNoticeToast(): void {
  toast('草稿已保存', {
    id: PREVIEW_IDS.notice,
    description: '内容会在下次打开时恢复。',
    duration: Infinity,
    action: { label: '撤销', onClick: () => undefined },
  })
}

/**
 * 展示成功通知：仅状态图标用成功绿，容器仍是灰阶，操作为「关闭」。
 *
 * 「关闭」直接调用 `toast.dismiss` 撤销本条目，是三种通知里唯一自带退场动作的。
 */
function showSuccessToast(): void {
  toast.success('保存成功', {
    id: PREVIEW_IDS.success,
    description: '任务设置已更新。',
    duration: Infinity,
    action: { label: '关闭', onClick: () => toast.dismiss(PREVIEW_IDS.success) },
  })
}

/**
 * 展示失败通知：仅状态图标用失败红，容器仍是灰阶，操作为「查看」。
 *
 * 文案给出可行动的下一步（检查连接后重试），不靠颜色单独表达错误。
 */
function showErrorToast(): void {
  toast.error('执行失败', {
    id: PREVIEW_IDS.error,
    description: '连接失败，请检查后重试。',
    duration: Infinity,
    action: { label: '查看', onClick: () => undefined },
  })
}

/** 依次展示普通、成功与失败三种预览通知。 */
function showAllPreviewToasts(): void {
  showNoticeToast()
  showSuccessToast()
  showErrorToast()
}

/**
 * 进入页面后延迟展示三种预览通知；返回清理函数，撤销定时器并关闭残留通知。
 *
 * 延迟是为了等 Toaster 挂载完成，避免首帧就丢通知。
 *
 * @returns 卸载用的清理函数：先撤销未到期的定时器，再按固定 id 关闭三条预览通知。
 */
function mountPreviewToasts(): () => void {
  const previewTimer = window.setTimeout(showAllPreviewToasts, 400)

  /** 卸载时撤销定时器，并关掉可能仍在屏幕上的预览通知。 */
  function clearPreviewToasts(): void {
    window.clearTimeout(previewTimer)
    toast.dismiss(PREVIEW_IDS.notice)
    toast.dismiss(PREVIEW_IDS.success)
    toast.dismiss(PREVIEW_IDS.error)
  }

  return clearPreviewToasts
}

/**
 * 「通知」组件页：三种语义的通知示例，固定 id 便于重复预览。
 *
 * @returns 该组件页渲染出的元素。
 */
export function ToastPage(): React.ReactElement {
  useEffect(mountPreviewToasts, [])

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
