#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

fail() {
  echo "✗ SECRET: $*" >&2
  failures=$((failures + 1))
}

tracked_env_files="$(
  git ls-files |
    awk -F/ '{
      name = $NF
      if (name ~ /^\.env/ && name != ".env.local.example") {
        print
      }
    }'
)"
if [[ -n "$tracked_env_files" ]]; then
  fail "发现已跟踪的环境文件（仅允许 .env.local.example）"
  while IFS= read -r file; do
    echo "  - $file" >&2
  done <<<"$tracked_env_files"
fi

for probe in .env .env.local .env.development .env.production .env.staging .env.ci; do
  if ! git check-ignore -q --no-index "$probe"; then
    fail "$probe 未被仓库忽略规则覆盖"
  fi
done

if git check-ignore -q --no-index .env.local.example; then
  fail ".env.local.example 被错误忽略，模板必须可以纳入版本控制"
fi

secret_pattern='(-----BEGIN ([A-Z0-9]+[[:space:]])*PRIVATE KEY-----|(AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{80,255}|glpat-[A-Za-z0-9_-]{20,255}|sk_live_[A-Za-z0-9]{20,255}|sk-[A-Za-z0-9_-]{32,255}|xox[baprs]-[A-Za-z0-9-]{20,255}|AIza[0-9A-Za-z_-]{35}|tskey-[A-Za-z]+-[A-Za-z0-9_-]{20,255})'
secret_files="$(
  git ls-files -z --cached --others --exclude-standard |
    xargs -0 grep -IlE -- "$secret_pattern" 2>/dev/null || true
)"
if [[ -n "$secret_files" ]]; then
  fail "以下文件包含疑似真实密钥（只报告文件名，不输出内容）"
  while IFS= read -r file; do
    echo "  - $file" >&2
  done <<<"$secret_files"
fi

if ((failures > 0)); then
  echo "密钥与环境文件检查失败：$failures 项" >&2
  exit 1
fi

echo "密钥与环境文件检查通过：环境文件默认忽略，未发现高置信度密钥。"

