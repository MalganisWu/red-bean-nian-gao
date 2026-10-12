'use client'

import { useState } from 'react'

import { TrajectoryInspector } from '@/components/TrajectoryInspector'
import { TrajectoryLedger } from '@/components/TrajectoryLedger'
import { TrajectoryTimeline } from '@/components/TrajectoryTimeline'
import type {
  TrajectoryCompaction,
  TrajectoryRecord,
  TrajectoryAttempt,
  TrajectorySessionEnd,
  TrajectoryTurn,
} from '@/components/trajectoryTypes'

import { SpecPageHeader } from './SpecPageHeader'

/* ===== 定稿演示数据（与 docs/design/session/session-trajectory.md 同口径） ===== */

const COMPACTION: TrajectoryCompaction = {
  id: 'c1',
  afterTurn: 2,
  at: '14:07:58',
  durationMs: 3200,
  beforeTokens: 42300,
  afterTokens: 8100,
  messages: 26,
  strategy: '保留最近 2 轮原文 + 早前消息摘要',
  status: 'success',
}

const TURNS: TrajectoryTurn[] = [
  {
    turn: 1,
    startedAt: '14:02:11',
    durationMs: 12400,
    tokens: 9362,
    records: [
      {
        id: 'r1',
        kind: 'user',
        at: '14:02:11',
        summary: '帮我调研一下红豆年糕的传统做法，整理成一份飞书文档',
      },
      {
        id: 'r2',
        kind: 'call',
        at: '14:02:11',
        durationMs: 4300,
        tokens: { input: 3218, output: 412, cache: 0 },
        summary: '规划：先搜索资料，再创建文档',
        thinking: '用户要两件事：调研做法 + 整理成飞书文档。先搜资料，再建文档。',
        attempts: [
          {
            id: 'q2',
            model: 'deepseek-chat',
            attempt: '1/1',
            durationMs: 4300,
            tokens: { input: 3218, output: 412, cache: 0 },
            status: 'success',
          },
        ],
      },
      {
        id: 'r3',
        kind: 'tool',
        name: 'web_search',
        target: '红豆年糕 传统做法',
        at: '14:02:12',
        durationMs: 1800,
        status: 'success',
        summary: '搜索红豆年糕做法',
        params: '{ "query": "红豆年糕 传统做法 配方", "top_k": 5 }',
        result: '返回 5 条结果：下厨房《红豆年糕》、豆果美食《古法红豆年糕》……',
      },
      {
        id: 'r4',
        kind: 'tool',
        name: 'web_fetch',
        target: 'xiachufang.com/recipe/1042',
        at: '14:02:14',
        durationMs: 2400,
        status: 'success',
        summary: '抓取配方页',
        params: '{ "url": "https://www.xiachufang.com/recipe/104286/" }',
        result: '页面正文 2,318 字：糯米粉 500g、红豆沙 300g……',
      },
      {
        id: 'r5',
        kind: 'tool',
        name: 'lark_doc_create',
        target: '《红豆年糕传统做法调研》',
        at: '14:02:17',
        durationMs: 1900,
        status: 'success',
        summary: '创建文档',
        params: '{ "title": "红豆年糕传统做法调研" }',
        result: '文档创建成功，docx_token: doxcnA1b2C3d4E5f',
      },
      {
        id: 'r6',
        kind: 'call',
        at: '14:02:19',
        durationMs: 4100,
        tokens: { input: 5104, output: 628, cache: 3072 },
        summary: '整理调研结论并写入文档',
        thinking: '资料够了，整理成结构化文档写入。',
        reply: '已整理完成：文档《红豆年糕传统做法调研》已创建，包含配比、五步流程和三个防裂要点。',
        attempts: [
          {
            id: 'q6',
            model: 'deepseek-chat',
            attempt: '1/1',
            durationMs: 4100,
            tokens: { input: 5104, output: 628, cache: 3072 },
            status: 'success',
          },
        ],
      },
    ],
    endState: { state: 'completed', at: '14:02:23' },
  },
  {
    turn: 2,
    startedAt: '14:05:47',
    durationMs: 23100,
    tokens: 27236,
    records: [
      {
        id: 'r7',
        kind: 'user',
        at: '14:05:47',
        summary: '很好，再帮我建一个每周五下午 3 点提醒我买材料做年糕的定时任务',
      },
      {
        id: 'r8',
        kind: 'call',
        at: '14:05:47',
        durationMs: 2100,
        tokens: { input: 6842, output: 355, cache: 5824 },
        summary: '决定委派定时任务子 Agent',
        thinking: '创建定时任务涉及 cron 表达式和任务编排，委派给子 Agent 处理更稳妥。',
        attempts: [
          {
            id: 'q8',
            model: 'deepseek-chat',
            attempt: '1/1',
            durationMs: 2100,
            tokens: { input: 6842, output: 355, cache: 5824 },
            status: 'success',
          },
        ],
      },
      {
        id: 'r9',
        kind: 'subagent',
        name: '定时任务配置助手',
        model: 'deepseek-chat',
        target: '创建每周五 15:00 的提醒任务',
        at: '14:05:49',
        durationMs: 18600,
        totalTokens: 12430,
        status: 'success',
        summary: '创建定时任务',
        result: '任务「每周五买年糕材料」创建成功（task_id: t-88213），下次执行 2026-09-18 15:00。',
        children: [
          {
            id: 'r9-1',
            kind: 'tool',
            name: 'cron_validate',
            target: '0 0 15 * * 5',
            at: '14:05:50',
            durationMs: 320,
            status: 'success',
            summary: '校验 cron',
            params: '{ "expr": "0 0 15 * * 5" }',
            result: '表达式合法',
          },
          {
            id: 'r9-2',
            kind: 'tool',
            name: 'task_create',
            target: '每周五买年糕材料',
            at: '14:05:52',
            durationMs: 1540,
            status: 'success',
            summary: '创建任务',
            params: '{ "name": "每周五买年糕材料" }',
            result: 'task_id: t-88213',
          },
        ],
      },
      {
        id: 'r10',
        kind: 'call',
        at: '14:06:08',
        durationMs: 2400,
        tokens: { input: 7120, output: 489, cache: 6656 },
        summary: '确认任务创建结果',
        thinking: '子 Agent 已建好任务，向用户确认。',
        reply: '定时任务已创建：每周五 15:00 提醒你买年糕材料，下次执行 9 月 18 日。',
        attempts: [
          {
            id: 'q10',
            model: 'deepseek-chat',
            attempt: '1/1',
            durationMs: 2400,
            tokens: { input: 7120, output: 489, cache: 6656 },
            status: 'success',
          },
        ],
      },
    ],
    endState: { state: 'completed', at: '14:06:10' },
  },
  {
    turn: 3,
    startedAt: '14:09:03',
    durationMs: 8600,
    tokens: 18092,
    note: '上下文 8,100 tok 起（压缩后）',
    records: [
      { id: 'r11', kind: 'user', at: '14:09:03', summary: '把刚才那份文档分享给张三' },
      {
        id: 'r12',
        kind: 'call',
        at: '14:09:03',
        durationMs: 1600,
        tokens: { input: 8412, output: 203, cache: 8064 },
        summary: '解析联系人并准备发送',
        thinking: '先解析「张三」的 open_id，再发文档消息。',
        attempts: [
          {
            id: 'q12a',
            model: 'deepseek-chat',
            attempt: '1/2',
            durationMs: 300,
            status: 'error',
            error: 'LLM 空响应，触发自动重试',
          },
          {
            id: 'q12b',
            model: 'deepseek-chat',
            attempt: '2/2',
            durationMs: 1300,
            tokens: { input: 8412, output: 203, cache: 8064 },
            status: 'success',
          },
        ],
      },
      {
        id: 'r13',
        kind: 'tool',
        name: 'lark_contact_resolve',
        target: '张三',
        at: '14:09:04',
        durationMs: 900,
        status: 'success',
        summary: '解析联系人',
        params: '{ "name": "张三" }',
        result: 'open_id: ou_88ab12cd34ef',
      },
      {
        id: 'r14',
        kind: 'tool',
        name: 'lark_im_send',
        target: '发送文档给张三',
        at: '14:09:05',
        durationMs: 1300,
        status: 'error',
        summary: '发送文档失败',
        params: '{ "open_id": "ou_88ab12cd34ef", "msg_type": "share_chat" }',
        result: '错误：应用未获得该用户的单聊权限（scope im:chat:send_as_user 未授权）',
      },
      {
        id: 'r15',
        kind: 'call',
        at: '14:09:08',
        durationMs: 2700,
        tokens: { input: 8930, output: 547, cache: 8256 },
        summary: '降级为协作者授权方案',
        thinking: '直接发消息没权限，改用分享链接方案。',
        reply: '直接发送受权限限制，已改为把张三加为文档协作者（可阅读）。',
        attempts: [
          {
            id: 'q15',
            model: 'deepseek-chat',
            attempt: '1/1',
            durationMs: 2700,
            tokens: { input: 8930, output: 547, cache: 8256 },
            status: 'success',
          },
        ],
      },
      {
        id: 'r16',
        kind: 'tool',
        name: 'lark_doc_share',
        target: 'doxcnA1b2C3d4E5f → ou_88ab12cd34ef',
        at: '14:09:09',
        durationMs: 1600,
        status: 'success',
        summary: '添加协作者',
        params: '{ "doc": "doxcnA1b2C3d4E5f", "perm": "view" }',
        result: '协作者添加成功',
      },
    ],
    endState: { state: 'completed', at: '14:09:11', note: '1 个工具失败，已降级恢复' },
  },
]

const SESSION_END: TrajectorySessionEnd = { at: '14:09:11', state: 'completed' }

/* 进行中轮次演示：末个已终结轮次（带「轮次 N 结束 · 完成」行）与紧随其后、endState 缺省的
   进行中轮次并列，直观对比「已终结」与「仍在流式输出」。endState 缺省 = 前端实时投影尚未
   收到轮次终态，此轮「时长」只是已确认活动区间的下界，且末条工具记录仍在执行。 */
const IN_PROGRESS_TURNS: TrajectoryTurn[] = [
  ...TURNS.filter((t) => t.turn === 3),
  {
    turn: 4,
    startedAt: '14:11:26',
    durationMs: 5200,
    tokens: null,
    note: '流式进行中 · 轮次终态未到',
    records: [
      {
        id: 'ip1',
        kind: 'user',
        at: '14:11:26',
        summary: '把文档里「保存与复热」那一节补全',
      },
      {
        id: 'ip2',
        kind: 'call',
        at: '14:11:26',
        durationMs: 1800,
        tokens: { input: 9120, output: 268, cache: 8704 },
        summary: '读取文档现有结构，规划补写内容',
        thinking: '先读现有章节，再补「保存与复热」一节。',
        attempts: [
          {
            id: 'ipq1',
            model: 'deepseek-chat',
            attempt: '1/1',
            durationMs: 1800,
            tokens: { input: 9120, output: 268, cache: 8704 },
            status: 'success',
          },
        ],
      },
      {
        id: 'ip3',
        kind: 'tool',
        name: 'lark_doc_read',
        target: 'doxcnA1b2C3d4E5f',
        at: '14:11:28',
        durationMs: 900,
        status: 'success',
        summary: '读取文档现有章节',
        params: '{ "doc": "doxcnA1b2C3d4E5f" }',
        result: '返回 3 个章节标题',
      },
      {
        id: 'ip4',
        kind: 'tool',
        name: 'lark_doc_write',
        target: '写入「保存与复热」章节',
        at: '14:11:29',
        status: 'running',
        summary: '正在写入章节内容',
      },
    ],
  },
]

/* 加载期一次性分配全局稳定序号 #N（展示顺序即序号顺序） */
let SEQ = 0
const assignSeq = (o: { seq?: number }) => {
  o.seq = ++SEQ
}
for (const t of TURNS) {
  for (const r of t.records) {
    assignSeq(r)
    for (const q of r.attempts ?? []) assignSeq(q)
    for (const c of r.children ?? []) assignSeq(c)
  }
  if (t.endState) assignSeq(t.endState)
  if (COMPACTION.afterTurn === t.turn) assignSeq(COMPACTION)
}
assignSeq(SESSION_END)
/* 审批与打断演示：审批行（LLM 发起挂起 → 等待用户）、被打断的工具（用户主动取消 → 未闭合）、
   以及两种终态（interrupt = 等待用户、crashed = 进程遗留）。
   审批在存储层是同一 callId 的两条 append-only 记录，投影重建为**一行**并给出 waitMs。 */
const APPROVAL_TURNS: TrajectoryTurn[] = [
  {
    turn: 5,
    startedAt: '14:13:02',
    durationMs: 202_000,
    tokens: 5732,
    records: [
      {
        id: 'ap1',
        kind: 'user',
        at: '14:13:02',
        summary: '把刚才那份文档分享给张三',
      },
      {
        id: 'ap2',
        kind: 'call',
        at: '14:13:02',
        summary: '需要人工确认后才能分享',
        thinking: '分享是对外动作，先让用户确认收件人。',
        durationMs: 2100,
        tokens: { input: 5104, output: 628, cache: 3072 },
        attempts: [
          {
            id: 'apq1',
            model: 'deepseek-chat',
            attempt: '1/1',
            durationMs: 2100,
            status: 'success',
            tokens: { input: 5104, output: 628, cache: 3072 },
          },
        ],
      },
      {
        id: 'ap3',
        kind: 'tool',
        at: '14:13:03',
        name: 'ask_user',
        summary: '确认分享给张三？',
        status: 'interrupt',
        durationMs: 0,
        result: '{"status":"answered"}',
        waitMs: 192_000,
      },
      {
        id: 'ap4',
        kind: 'call',
        at: '14:16:16',
        summary: '已分享给张三',
        reply: '已把文档分享给张三，对方会收到通知。',
        durationMs: 1400,
        tokens: { input: 6180, output: 214, cache: 5104 },
        attempts: [
          {
            id: 'apq4',
            model: 'deepseek-chat',
            attempt: '1/1',
            durationMs: 1400,
            status: 'success',
            tokens: { input: 6180, output: 214, cache: 5104 },
          },
        ],
      },
    ],
    endState: { at: '14:16:17', state: 'completed' },
  },
  {
    turn: 6,
    startedAt: '14:20:00',
    durationMs: 84_000,
    tokens: null,
    records: [
      { id: 'ap5', kind: 'user', at: '14:20:00', summary: '跑一遍全量导出' },
      {
        id: 'ap6',
        kind: 'tool',
        at: '14:20:01',
        name: 'export_all',
        summary: 'export_all',
        status: 'incomplete',
        durationMs: 84_000,
      },
    ],
    // 用户主动取消：工具被 打断 → incomplete（不是工具失败）
    endState: { at: '14:21:24', state: 'cancelled', note: '用户停止' },
  },
]

/* 进行中演示复用 turn 3 的记录（序号已在上方分配），只补新加的未终结轮次，避免覆盖既有序号 */
for (const t of IN_PROGRESS_TURNS.filter((item) => item.endState === undefined)) {
  for (const r of t.records) {
    assignSeq(r)
    for (const q of r.attempts ?? []) assignSeq(q)
    for (const c of r.children ?? []) assignSeq(c)
  }
}

for (const t of APPROVAL_TURNS) {
  for (const r of t.records) {
    assignSeq(r)
    for (const q of r.attempts ?? []) assignSeq(q)
  }
  if (t.endState) assignSeq(t.endState)
}

const EMPTY_TURNS: TrajectoryTurn[] = []

/** 在演示数据中按 id 查一条记录，子调用也算记录。 */
function findRecord(id: string | undefined): TrajectoryRecord | undefined {
  if (!id) return undefined
  for (const t of TURNS) {
    for (const r of t.records) {
      if (r.id === id) return r
      for (const c of r.children ?? []) if (c.id === id) return c
    }
  }
  return undefined
}

/** 在演示数据中按 id 查一次尝试明细。 */
function findAttempt(id: string | undefined): TrajectoryAttempt | undefined {
  if (!id) return undefined
  for (const t of TURNS) {
    for (const r of t.records) {
      for (const q of r.attempts ?? []) if (q.id === id) return q
    }
  }
  return undefined
}

/** 按 id 反查它所属轮次的标签，供检查器标题使用。 */
function turnLabelOf(id: string | undefined): string | undefined {
  for (const t of TURNS) {
    if (t.records.some((r) => r.id === id || (r.children ?? []).some((c) => c.id === id)))
      return `轮次 ${t.turn}`
    if (t.records.some((r) => (r.attempts ?? []).some((q) => q.id === id))) return `轮次 ${t.turn}`
  }
  return undefined
}

/** 会话轨迹视图 Showcase：泳道时序概览 + 轮次记录表 + 记录检查器。 */
export function TrajectoryPage() {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  /** 点产出行时携带的 tab（思考 / 正文 / 工具调用）——让详情直接停在那一块。 */
  const [selectedTab, setSelectedTab] = useState<string | undefined>(undefined)
  const [filter, setFilter] = useState('')
  const [focusIds, setFocusIds] = useState<ReadonlySet<string> | null>(null)

  /** 选中记录：记住产出行带来的 tab；再点一次同一条（未带 tab）即清空选中。 */
  function handleSelect(id: string, tab?: string): void {
    setSelectedTab(tab)
    setSelectedId((cur) => (cur === id && tab === undefined ? undefined : id))
  }

  const selectedRecord = findRecord(selectedId)
  const selectedAttempt = selectedRecord ? undefined : findAttempt(selectedId)
  const selectedCompaction = selectedId === COMPACTION.id ? COMPACTION : undefined
  const inspectorOpen = Boolean(selectedRecord || selectedAttempt || selectedCompaction)

  return (
    <div className="conversation-showcase">
      <SpecPageHeader
        title="会话轨迹 · Session Trajectory"
        description="会话的只读审计视图：泳道时序概览回答「什么时候在做什么」（可拖选区间聚焦），轮次记录表回答「每一步是什么、多少 token、多长时间」，检查器回答「完整内容」。"
        note="Real components · 泳道概览 / 记录表 / 检查器 · Light / Dark"
      />

      <section className="spec-section">
        <h3 className="spec-section__title">
          Interactive reference（点击行/段打开检查器，泳道可拖选聚焦，搜索可过滤）
        </h3>
        <div className="overflow-clip rounded-lg border border-border">
          <TrajectoryTimeline
            turns={TURNS}
            compaction={COMPACTION}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId((cur) => (cur === id ? undefined : id))}
            onRangeFocus={setFocusIds}
          />
          {/* relative + absolute：检查器**覆盖**在表格右侧，不参与布局，表格宽度不受影响。
              外层容器必须有**有界高度**：面板用 `inset-y-0`，高度取自容器——若容器跟着整张表长高，
              面板内容会贴在它顶端，页面一滚就滚出视口（详情"只在顶层显示"）。
              所以表格放进一个 max-h 滚动容器，面板作为它的兄弟节点覆盖在上面。 */}
          <div className="relative">
            <div className="max-h-[70vh] min-w-0 overflow-y-auto px-6 pb-10">
              <TrajectoryLedger
                turns={TURNS}
                compaction={COMPACTION}
                sessionEnd={SESSION_END}
                filterText={filter}
                onFilterChange={setFilter}
                selectedId={selectedId}
                onSelect={handleSelect}
                focusIds={focusIds}
              />
            </div>
            {inspectorOpen && (
              <TrajectoryInspector
                className="absolute inset-y-0 right-0 z-20"
                record={selectedRecord}
                request={selectedAttempt}
                compaction={selectedCompaction}
                turnLabel={turnLabelOf(selectedId)}
                initialTab={selectedTab}
                onSelectRecord={(id) => setSelectedId(id)}
                onClose={() => setSelectedId(undefined)}
              />
            )}
          </div>
        </div>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">进行中轮次 · In Progress</h3>
        <div className="overflow-clip rounded-lg border border-border px-6 pb-10 pt-4">
          <TrajectoryLedger turns={IN_PROGRESS_TURNS} />
        </div>
        <p className="spec-section__note mt-3">
          流式进行中、尚未终结的轮次（<code>endState</code> 缺省）：标题行显示「进行中」chip，
          且不渲染「轮次 N 结束 · 完成」行；末条工具记录仍在执行，其「时长」显示「—」。
          未终结轮次标题行的「时长」只代表已确认活动区间的下界，不是最终耗时。 可与上方 Interactive
          reference 中带终态结束行的轮次对照。
        </p>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">审批与打断 · Approval &amp; Interrupt</h3>
        <div className="overflow-clip rounded-lg border border-border px-6 pb-10 pt-4">
          <TrajectoryLedger turns={APPROVAL_TURNS} />
        </div>
        <p className="spec-section__note mt-3">
          轮次 5：审批是**一次工具调用**——身份 chip 显示「工具 · 等待审批」（空心方块节点），
          合并后的行给出<strong>等待时长</strong>（与工具执行耗时分开），轮次终态为
          <strong>「等待用户」</strong>（wire 值 <code>interrupt</code>，LLM 发起挂起，<em>不是</em>
          中断）。 轮次 6：用户主动取消把在跑的工具收成 <code>incomplete</code> → chip 显示 「工具 ·
          未闭合」，终态「已取消」——「被用户打断」与「工具失败」是两件事。
        </p>
      </section>

      <section className="spec-section">
        <h3 className="spec-section__title">Empty</h3>
        <div className="rounded-lg border border-border px-6 py-10 text-center text-[13px] text-foreground-muted">
          该会话暂无可回放的轨迹记录。
        </div>
        <div className="mt-4 opacity-60">
          <TrajectoryTimeline turns={EMPTY_TURNS} />
        </div>
      </section>
    </div>
  )
}
