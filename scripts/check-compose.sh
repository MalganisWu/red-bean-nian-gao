#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="$ROOT/backend/docker-compose.yml"
ENV_EXAMPLE="$ROOT/backend/.env.local.example"

failures=0

fail() {
  echo "✗ COMPOSE: $*" >&2
  failures=$((failures + 1))
}

if grep -qE '^[[:space:]]*container_name:' "$COMPOSE_FILE"; then
  fail "禁止固定 container_name；应由 Compose project 隔离不同工作区"
fi

while IFS= read -r image; do
  if [[ "$image" != *@sha256:* && ! "$image" =~ :([0-9]+\.[0-9]+(\.[0-9]+)?|RELEASE\.[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z)$ ]]; then
    fail "镜像必须固定到明确版本，当前为 $image"
  fi
done < <(sed -nE 's/^[[:space:]]*image:[[:space:]]*([^[:space:]#]+).*/\1/p' "$COMPOSE_FILE")

for port in 5432 6379 9000 9001; do
  line="$(grep -E "^[[:space:]]*-[[:space:]]*[\"']?[^#]*:${port}[\"']?([[:space:]]*#.*)?$" "$COMPOSE_FILE" | head -n 1 || true)"
  if [[ -z "$line" ]]; then
    fail "缺少容器端口 $port 的显式映射"
  elif [[ "$line" != *"127.0.0.1:"* ]]; then
    fail "容器端口 $port 必须只绑定 127.0.0.1"
  fi
done

for variable in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB REDIS_PASSWORD MINIO_ROOT_USER MINIO_ROOT_PASSWORD; do
  if ! grep -Fq "\${${variable}:?" "$COMPOSE_FILE"; then
    fail "$variable 必须由本地 env 文件注入且不能为空"
  fi
done

if [[ ! -f "$ENV_EXAMPLE" ]]; then
  fail "缺少 backend/.env.local.example"
else
  for variable in COMPOSE_PROJECT_NAME POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB REDIS_PASSWORD MINIO_ROOT_USER MINIO_ROOT_PASSWORD; do
    if ! grep -qE "^${variable}=" "$ENV_EXAMPLE"; then
      fail "backend/.env.local.example 缺少 $variable"
    fi
  done
  for variable in POSTGRES_PASSWORD REDIS_PASSWORD MINIO_ROOT_PASSWORD; do
    value="$(sed -nE "s/^${variable}=(.*)$/\1/p" "$ENV_EXAMPLE" | tail -n 1)"
    if [[ -n "$value" ]]; then
      fail "backend/.env.local.example 的 $variable 必须留空，禁止提交可直接使用的密码"
    fi
  done
fi

if ! git -C "$ROOT" check-ignore -q backend/.env.local; then
  fail "backend/.env.local 必须被 Git 忽略"
fi

if git -C "$ROOT" check-ignore -q backend/.env.local.example; then
  fail "backend/.env.local.example 必须纳入版本控制"
fi

# 模板必须同时覆盖「基础设施键」与「应用键」：单源之后照它填就能跑起来
for variable in DATABASE_URL REDIS_URL JWT_SECRET LLM_API_KEY; do
  if ! grep -qE "^${variable}=" "$ENV_EXAMPLE"; then
    fail "backend/.env.local.example 缺少应用键 $variable"
  fi
done

if ((failures > 0)); then
  echo "Compose 本地环境检查失败：$failures 项" >&2
  exit 1
fi

echo "Compose 本地环境检查通过：镜像已固定、端口仅回环监听、凭据由本地 env 注入。"
