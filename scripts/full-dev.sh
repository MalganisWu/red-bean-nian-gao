#!/usr/bin/env bash
# 同时启动后端与前端；任一退出即清理另一个，两者都不留在端口上。
#
# 存在的理由：Make 的每一行配方各起一个 shell。原先的写法是
#     $(PNPM_BE) dev &     ← 第一个 shell 里的子进程，shell 随即退出
#     $(PNPM) dev          ← 第二个 shell，前台
#     wait                 ← 第三个 shell：等不到第一个 shell 起的那个进程
# 于是中断联合启动时只有前台的前端退出，后端会留在 8080 端口上。
#
# 这里用「同一进程组 + 显式 PID + trap」代替上面那种跨 shell 的 `wait`。
# 不用 `wait -n` —— macOS 自带的 bash 是 3.2，没有这个内建命令。
set -euo pipefail

cd "$(cd "$(dirname "$0")/.." && pwd)"

backend_pid=""
frontend_pid=""

cleanup() {
	local code=$?
	trap - EXIT INT TERM
	for pid in "$backend_pid" "$frontend_pid"; do
		[ -n "$pid" ] || continue
		kill -TERM "$pid" 2>/dev/null || true
	done
	# pnpm 会把信号转发给它拉起的子进程，给它一点时间优雅退出；还在的强杀
	sleep 1
	for pid in "$backend_pid" "$frontend_pid"; do
		[ -n "$pid" ] || continue
		kill -KILL "$pid" 2>/dev/null || true
	done
	wait 2>/dev/null || true
	exit "$code"
}
trap cleanup EXIT INT TERM

echo "启动后端（8080）..."
pnpm --filter @red-bean-nian-gao/backend dev &
backend_pid=$!

echo "启动前端（5173）..."
pnpm --filter frontend dev &
frontend_pid=$!

# 任一先行退出即收敛：取它的退出码，另一个交给 trap 清理
while kill -0 "$backend_pid" 2>/dev/null && kill -0 "$frontend_pid" 2>/dev/null; do
	sleep 1
done

if ! kill -0 "$backend_pid" 2>/dev/null; then
	wait "$backend_pid"
else
	wait "$frontend_pid"
fi
