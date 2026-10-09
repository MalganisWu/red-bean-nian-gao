#!/usr/bin/env bash

set -euo pipefail

readonly root="$(cd "$(dirname "$0")/.." && pwd)"
sdk_dir="${1:-../red-bean-qing-tuan}"
lock_file="${2:-runtime.lock}"

if [[ "$sdk_dir" != /* ]]; then
	sdk_dir="$root/$sdk_dir"
fi
if [[ "$lock_file" != /* ]]; then
	lock_file="$root/$lock_file"
fi

if [[ ! -f "$lock_file" ]]; then
	printf '缺少 Runtime revision 文件：%s\n' "$lock_file" >&2
	exit 1
fi
if ! git -C "$sdk_dir" rev-parse --git-dir >/dev/null 2>&1; then
	printf '找不到 Runtime Git 工作区：%s\n' "$sdk_dir" >&2
	printf 'Runtime SDK 是独立仓库，必须与本仓并排放在同一父目录下。\n' >&2
	printf '执行 make bootstrap 会自动克隆并切到 runtime.lock 锁定的版本，\n' >&2
	printf '或用 SDK_DIR=<路径> 指向已有的工作区。\n' >&2
	exit 1
fi

expected="$(tr -d '[:space:]' < "$lock_file")"
if [[ ! "$expected" =~ ^[0-9a-f]{40}$ ]]; then
	printf 'Runtime revision 格式无效：%s\n' "$expected" >&2
	exit 1
fi

actual="$(git -C "$sdk_dir" rev-parse HEAD)"
if [[ "$actual" != "$expected" ]]; then
	printf 'Runtime revision 不匹配。\n' >&2
	printf '  期望：%s\n' "$expected" >&2
	printf '  实际：%s\n' "$actual" >&2
	printf '执行 make bootstrap 会切到 runtime.lock 锁定的版本。\n' >&2
	printf '若正在联合开发两仓：先提交 Runtime，再把新 revision 写进 runtime.lock。\n' >&2
	exit 1
fi

if [[ -n "$(git -C "$sdk_dir" status --porcelain --untracked-files=all)" ]]; then
	printf 'Runtime 工作区存在未提交改动，无法证明当前构建对应锁定 revision：%s\n' "$sdk_dir" >&2
	exit 1
fi

printf 'Runtime revision 已锁定：%s\n' "$actual"
