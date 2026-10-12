/**
 * Quiet Tool 返回动作：‹ 前缀 + 弱化小字，hover 使用主题豆沙色。
 * 全站返回动作的唯一实现——不要在新页面再手写这个 class 串。
 */
interface BackLinkProps {
  /** 完整文案（含动词，如「返回聊天」「返回任务详情」）；组件自动加 ‹ 前缀 */
  label: string
  onClick: () => void
}

/** 返回入口；`label` 由调用方给出上一层的名称。 */
export function BackLink({ label, onClick }: BackLinkProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="min-h-11 cursor-pointer text-label tracking-label-wide text-foreground-faint transition-colors hover:text-primary"
    >
      ‹ {label}
    </button>
  )
}
