#!/usr/bin/env bash
# check-ds-drift.sh — design-system ↔ frontend 引用漂移检查
#
# 检测四类漂移：
#   MISSING     前端 import 了 design-system 不存在的组件（错误，exit 1）
#   DEAD        design-system 组件前端零引用（警告）
#   NO-SHOWCASE 公开组件无任何 showcase 页引用（错误，exit 1）
#   COLOR-DOC   语义颜色 token 未进入 Color foundation 或可下载设计文档（错误，exit 1）
#
# 内部件（不对外承诺 API，豁免 DEAD/NO-SHOWCASE）：
INTERNAL=(ToolItem MarkdownCodeBlock)

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DS_COMPONENTS="$ROOT/design-system/src/components"
DS_SHOWCASE="$ROOT/design-system/src/showcase"
FRONTEND_SRC="$ROOT/frontend/src"

errors=0
warnings=0
missing_errors=0
showcase_errors=0

# A 集：design-system 组件清单
components=$(find "$DS_COMPONENTS" -maxdepth 1 -name '*.tsx' -exec basename {} .tsx \; | sort)

# B 集：前端实际引用的 retroui 组件
used=$(grep -rhoE "@/components/retroui/[A-Za-z]+" "$FRONTEND_SRC" | sed 's|.*/||' | sort -u)

echo "== design-system ↔ frontend 引用漂移检查 =="

# 1. MISSING：前端引用了不存在的组件
for name in $used; do
  if [ ! -f "$DS_COMPONENTS/${name}.tsx" ]; then
    echo "✗ MISSING: 前端引用 @/components/retroui/${name}，但 design-system/src/components/${name}.tsx 不存在"
    errors=$((errors + 1))
    missing_errors=$((missing_errors + 1))
  fi
done

# 2./3. DEAD / NO-SHOWCASE（内部件豁免）
for name in $components; do
  skip=0
  for w in "${INTERNAL[@]}"; do
    [ "${name}" = "$w" ] && skip=1
  done
  [ "$skip" -eq 1 ] && continue

  if ! grep -qx "${name}" <<< "$used"; then
    echo "⚠ DEAD: ${name} 在 design-system 存在但前端零引用——删除或当次接入，勿留观望"
    warnings=$((warnings + 1))
  fi
  if ! grep -rlqE "components/${name}(['\"]|\\.tsx['\"])" "$DS_SHOWCASE"; then
    echo "✗ NO-SHOWCASE: ${name} 缺少 showcase 展示（showcase/ 中无引用）"
    errors=$((errors + 1))
    showcase_errors=$((showcase_errors + 1))
  fi
done

echo "---"
echo "MISSING(错误): $missing_errors  NO-SHOWCASE(错误): $showcase_errors  DEAD(警告): $warnings"

# 4. TOKEN-DRIFT：design-tokens.css 与 frontend/globals.css 的 :root token 值必须 1:1；
#    双端 @theme inline 键集必须对等（值允许各自引用方式不同，键必须一致）
extract_root_tokens() {
  # 只比 :root 声明段：@theme inline 是工具类映射层（双端各自声明），不属于 token 值对等范围
  sed '/@theme inline/,$d' "$1" | grep -oE '^\s+--[a-z0-9-]+: [^;]+;' | sed -E 's/^ +//; s/[[:space:]]+/ /g; s/0\././g; s/"/'"'"'/g' | sort
}
extract_theme_keys() {
  sed -n '/@theme inline/,/^}/p' "$1" | grep -oE '^\s+--[a-z0-9-]+:' | tr -d ' :' | sort
}

# frontend 直接 import canonical token 文件时天然不存在值漂移；若未来改回复制，
# 再逐值比较 :root 声明，避免检查脚本反而迫使维护第二份 token。
if grep -Eq "@import [\"']\.\./\.\./\.\./design-system/src/styles/design-tokens\.css[\"'];" \
  "$ROOT/frontend/src/styles/globals.css"; then
  token_diff=""
else
  token_diff=$(diff <(extract_root_tokens "$ROOT/design-system/src/styles/design-tokens.css") \
                    <(extract_root_tokens "$ROOT/frontend/src/styles/globals.css") | grep -E '^[<>]' || true)
fi
if [ -n "$token_diff" ]; then
  echo "✗ TOKEN-DRIFT: :root token 值不一致（左=design-tokens.css 右=frontend/globals.css）"
  echo "$token_diff"
  errors=$((errors + 1))
fi

theme_diff=$(diff <(extract_theme_keys "$ROOT/design-system/src/styles/globals.css") \
                  <(extract_theme_keys "$ROOT/frontend/src/styles/globals.css") | grep -E '^[<>]' || true)
if [ -n "$theme_diff" ]; then
  echo "✗ THEME-DRIFT: @theme inline 键集不对等（左=design-system 右=frontend）"
  echo "$theme_diff"
  errors=$((errors + 1))
fi

# 5. COLOR-DOC：每个语义颜色角色必须同时出现在可视 Color 页和可下载设计文档中。
# process-active-ring 是阴影组合值，不属于单一颜色角色。
semantic_color_tokens=$(
  sed -n '/2\. Semantic Tokens/,/3\. Component Tokens/p' \
    "$ROOT/design-system/src/styles/design-tokens.css" |
    grep -oE '^  --[a-z0-9-]+:' |
    sed 's/^  //; s/:$//' |
    grep -v '^--process-active-ring$' |
    sort -u
)
color_doc_missing=0

for token in $semantic_color_tokens; do
  if ! grep -Fq -- "$token" "$ROOT/design-system/src/foundations/ColorPage.tsx"; then
    echo "✗ COLOR-DOC: ${token} 未出现在 Color foundation"
    errors=$((errors + 1))
    color_doc_missing=$((color_doc_missing + 1))
  fi
  if ! grep -Fq -- "${token#--}" "$ROOT/design-system/src/foundations/philosophyMarkdown.ts"; then
    echo "✗ COLOR-DOC: ${token} 未出现在可下载设计文档"
    errors=$((errors + 1))
    color_doc_missing=$((color_doc_missing + 1))
  fi
done
echo "COLOR-DOC(错误): $color_doc_missing"

[ "$errors" -gt 0 ] && exit 1
exit 0
