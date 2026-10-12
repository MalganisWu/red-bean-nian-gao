#!/usr/bin/env bash
# 通用规范件的跨仓一致性检查。
#
# 两仓各存一份 docs/standards/typescript-common-conventions.md，内容必须逐字相同。本脚本与产品仓中的
# 同名脚本逐字一致，且不写死「哪一仓是兄弟」，因此同一份代码在两仓都能跑。
#
# 上游（Runtime SDK 仓）在兄弟工作区缺失时跳过而非失败；产品仓的 CI 会把 SDK 按 runtime.lock 的 SHA
# checkout 成兄弟目录，因此「产品仓锁哪个 SDK 版本，就跟着那个版本的通用规范走」由本检查保证。

set -euo pipefail

readonly root="$(cd "$(dirname "$0")/.." && pwd)"
readonly relative="docs/standards/typescript-common-conventions.md"
readonly self_file="$root/$relative"
readonly self_name="$(basename "$root")"
readonly candidates=(
	"red-bean-qing-tuan"
	"red-bean-nian-gao"
)

if [[ ! -f "$self_file" ]]; then
	printf '缺少通用规范件：%s\n' "$relative" >&2
	exit 1
fi

for name in "${candidates[@]}"; do
	if [[ "$name" == "$self_name" ]]; then
		continue
	fi
	sibling="$(cd "$root/.." && pwd)/$name"
	if [[ ! -d "$sibling" || "$sibling" == "$root" ]]; then
		continue
	fi
	if [[ ! -f "$sibling/$relative" ]]; then
		continue
	fi
	if ! diff -q "$self_file" "$sibling/$relative" >/dev/null; then
		printf '通用规范件与 %s 不一致：%s\n' "$name" "$relative" >&2
		printf '两仓必须逐字相同。先改上游并提交，再在本仓 bump 依赖锁定时同步。\n' >&2
		diff "$self_file" "$sibling/$relative" >&2 || true
		exit 1
	fi
	printf '通用规范件与 %s 逐字一致：%s\n' "$name" "$relative"
	exit 0
done

printf '未找到兄弟仓工作区，跳过通用规范件一致性检查：%s\n' "$relative"
