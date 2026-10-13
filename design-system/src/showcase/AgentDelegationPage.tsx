import { DelegationBlock, type DelegationStatus } from '@/components/DelegationBlock'
import { ProcessFold, type ProcessStep } from '@/components/ProcessFold'

import { SpecPageHeader } from './SpecPageHeader'
import './conversation-showcase.css'

/**
 * 单个委派状态的展示样例：把状态映射为时长、摘要、工具行与结论。
 *
 * `awaiting_user` / `cancelled` / `incomplete` 三种非终态各自走独立分支，
 * 因此这里用互斥布尔量而不是查表，避免新增状态时静默落到 default。
 *
 * @param props - 组件属性；`status` 为要演示的委派状态。
 */
function DelegationExample(props: { status: DelegationStatus }) {
  const { status } = props
  const failed = status === 'failed'
  const running = status === 'running'
  const awaiting = status === 'awaiting_user'
  const interrupted = status === 'cancelled' || status === 'incomplete'

  return (
    <DelegationBlock
      agentName="日志分析"
      status={status}
      duration={running ? '6s' : failed ? '12s' : '41s'}
      summary={
        running
          ? '2 个事件'
          : awaiting
            ? '等待用户补充范围'
            : interrupted
              ? '执行在完成前停止'
              : failed
                ? '权限不足'
                : '3 次工具调用 · 1 份结论'
      }
      items={[
        { itemType: 'step', content: '查找 7 月 18 日周报失败日志。' },
        {
          itemType: 'tool',
          tool: {
            name: 'read_file',
            label: 'logs/weekly-0718.log',
            status: running
              ? 'running'
              : failed
                ? 'failed'
                : status === 'cancelled'
                  ? 'cancelled'
                  : status === 'incomplete'
                    ? 'incomplete'
                    : 'success',
            error: failed ? 'permission denied' : undefined,
            result: !running && !failed && !interrupted ? '找到 DB_TIMEOUT 记录' : undefined,
          },
        },
      ]}
      output={status === 'completed' ? '根因已定位：数据库连接等待超时。' : undefined}
    />
  )
}

/**
 * 把某一委派状态组装成一条 `ProcessFold` 工具步骤，并把委派行挂在它的子节点上。
 *
 * 这是展示站的演示夹具：状态到步骤状态的映射只服务于「一层嵌套」的展示，
 * 不承担真实投影职责。
 *
 * @param props - 组件属性；`status` 为要演示的委派状态。
 * @returns 供 `ProcessFold` 渲染的工具步骤，其 tool 状态与结果均由 `status` 推导。
 */
function DelegationStep(props: { status: DelegationStatus }): ProcessStep {
  const { status } = props
  const active = status === 'running' || status === 'awaiting_user'

  return {
    kind: 'tool',
    state: status === 'awaiting_user' ? 'waiting' : active ? 'active' : 'complete',
    tool: {
      name: 'call_helper',
      callId: `call_${status}`,
      label: '日志分析',
      status: active
        ? 'running'
        : status === 'completed'
          ? 'success'
          : status === 'failed'
            ? 'failed'
            : status,
      params: '{"task":"分析最近一次请求超时"}',
      result: status === 'completed' ? '子 Agent 已返回根因摘要' : undefined,
    },
    subAgent: <DelegationExample status={status} />,
  }
}

/** 「子代理委派」组件页：按状态枚举展示委派行的各种形态。 */
export function AgentDelegationPage() {
  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="子代理委派 · Agent Delegation"
        description="子任务是 Process 中的一类事件；可展开查看，但不创建第二套视觉容器"
        note="Real component · 继承同一套灰阶、状态色、字体和 disclosure。"
      />

      {(
        ['running', 'awaiting_user', 'completed', 'failed', 'cancelled', 'incomplete'] as const
      ).map((status) => (
        <section key={status} className="spec-section">
          <h3 className="spec-section__title">
            {
              {
                running: 'Running',
                awaiting_user: 'Awaiting user',
                completed: 'Completed',
                failed: 'Failed',
                cancelled: 'Cancelled',
                incomplete: 'Incomplete',
              }[status]
            }
          </h3>
          <div className="spec-frame">
            <ProcessFold
              status={
                status === 'awaiting_user'
                  ? 'awaiting'
                  : status === 'cancelled' || status === 'incomplete'
                    ? 'cancelled'
                    : status
              }
              defaultExpanded
              steps={[
                DelegationStep({ status }),
                ...(status === 'completed'
                  ? [{ kind: 'narration' as const, content: '已接收子任务结论，继续整理建议。' }]
                  : []),
              ]}
            />
          </div>
        </section>
      ))}

      <section className="spec-section">
        <h3 className="spec-section__title">多工具归属 · ID matching</h3>
        <div className="spec-frame">
          <ProcessFold
            status="completed"
            defaultExpanded
            steps={[
              {
                kind: 'tool',
                tool: {
                  name: 'read_file',
                  callId: 'call_read',
                  label: 'logs/app.log',
                  status: 'success',
                },
              },
              DelegationStep({ status: 'completed' }),
            ]}
          />
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">旧数据降级 · Missing parent ID</h3>
        <div className="spec-frame max-w-[360px]">
          <ProcessFold
            status="completed"
            defaultExpanded
            steps={[
              {
                kind: 'sub_agent',
                subAgent: (
                  <DelegationBlock
                    agentName="名称很长的历史数据分析子代理"
                    status="completed"
                    summary="缺少 parent_call_id 时保留独立委派行，不猜测父工具"
                    items={[]}
                  />
                ),
              },
            ]}
          />
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Rules</h3>
        <div className="spec-rule-grid">
          <div>
            <strong>一层嵌套</strong>
            <p>父工具和子任务共用一个时间线节点；子任务详情只增加一条缩进线。</p>
          </div>
          <div>
            <strong>状态继承</strong>
            <p>成功绿、失败红、运行中中性灰；所有颜色旁必须有状态文字。</p>
          </div>
        </div>
      </section>
    </div>
  )
}
