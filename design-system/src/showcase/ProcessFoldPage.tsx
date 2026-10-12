import { ProcessFold, type ProcessStep } from '@/components/ProcessFold'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

const COMPLETED_STEPS: ProcessStep[] = [
  { kind: 'think', content: '确认配置范围和依赖。', state: 'complete' },
  {
    kind: 'tool',
    state: 'complete',
    tool: {
      name: 'apply_patch',
      label: 'config/sync.yaml',
      status: 'success',
      duration: '1s',
      result: '修改 14 行，公开接口未变化',
    },
  },
  {
    kind: 'tool',
    state: 'complete',
    tool: {
      name: 'run_tests',
      label: 'sync policy',
      status: 'success',
      duration: '9s',
    },
  },
]

/** 「过程折叠」组件页：按状态展示过程轨道。 */
export function ProcessFoldPage() {
  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="过程折叠 · ProcessFold"
        description="一轮回复中，进展、工具、委派和确认共享同一个可折叠时间线"
        note="Real component · running / awaiting / completed / failed / cancelled"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">Running · 默认展开</h3>
        <div className="spec-frame">
          <ProcessFold
            status="running"
            totalDuration="3s"
            steps={[
              { kind: 'narration', content: '先读取配置，再执行校验。', state: 'complete' },
              {
                kind: 'tool',
                state: 'complete',
                tool: {
                  name: 'read_file',
                  label: 'config/sync.yaml',
                  status: 'success',
                  duration: '1s',
                  result: 'retry.max = 1 · retry.interval = 5s',
                },
              },
              {
                kind: 'tool',
                state: 'active',
                tool: {
                  name: 'run_tests',
                  label: 'sync policy',
                  status: 'running',
                  duration: '3s',
                },
              },
            ]}
          />
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Completed · 默认折叠</h3>
        <div className="spec-frame">
          <ProcessFold status="completed" totalDuration="12s" steps={COMPLETED_STEPS} />
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Failed · 默认展开</h3>
        <div className="spec-frame">
          <ProcessFold
            status="failed"
            totalDuration="2s"
            steps={[
              { kind: 'narration', content: '读取发布配置并检查目标环境。' },
              {
                kind: 'tool',
                tool: {
                  name: 'read_file',
                  label: 'config/release.yaml',
                  status: 'failed',
                  duration: '1s',
                  error: 'permission denied: config/release.yaml',
                  defaultExpanded: true,
                },
              },
            ]}
          />
        </div>
        <p className="spec-section__note">
          失败使用鲜红文字；单个 Tool 失败不自动推导整个 Process 失败，回合终态由调用方明确传入。
        </p>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Awaiting / Cancelled</h3>
        <div className="spec-frame space-y-5">
          <ProcessFold
            status="awaiting"
            steps={[
              { kind: 'narration', content: '已完成风险检查。', state: 'complete' },
              {
                kind: 'approval',
                state: 'waiting',
                approval: (
                  <p className="m-0 text-[13px] text-foreground-secondary">等待确认执行范围</p>
                ),
              },
            ]}
          />
          <ProcessFold
            status="cancelled"
            defaultExpanded
            steps={[
              {
                kind: 'tool',
                state: 'complete',
                tool: {
                  name: 'sync_files',
                  label: 'release assets',
                  status: 'incomplete',
                  duration: '5s',
                },
              },
              {
                kind: 'tool',
                state: 'complete',
                tool: {
                  name: 'publish',
                  label: 'production',
                  status: 'cancelled',
                },
              },
            ]}
          />
        </div>
      </section>
    </div>
  )
}
