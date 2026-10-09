/**
 * 本进程启动时刻（epoch ms），在模块求值期确定，此后不再变化。
 *
 * 用途：`session_runs` 的 running 状态只有在"本进程内"才可能仍在执行。轨迹读取端据此区分
 * 「进行中」与「崩溃遗留」——进程重启后残留的 running 行不可能还在跑，必须按中断收尾，
 * 否则审计视图会永远显示一条不会结束的运行。单进程部署下这是确定性判据，无需心跳或超时猜测。
 */
export const PROCESS_STARTED_AT: number = Date.now()
