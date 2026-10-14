#!/usr/bin/env bash

set -euo pipefail
shopt -s nullglob

readonly root="$(cd "$(dirname "$0")/.." && pwd)"
errors=0
skill_count=0
indexed_living_count=0

report_error() {
	printf '✗ %s\n' "$1" >&2
	errors=$((errors + 1))
}

check_skill_format() {
	local skill_dir="$1"
	local skill_file="$skill_dir/SKILL.md"
	local directory_name="$(basename "$skill_dir")"
	local line
	local key
	local value
	local declared_name=""
	local description=""
	local seen_keys="|"
	local closed=false

	if [[ "$(sed -n '1p' "$skill_file")" != "---" ]]; then
		report_error "skills/$directory_name/SKILL.md 缺少起始 YAML frontmatter"
		return
	fi

	while IFS= read -r line; do
		if [[ "$line" == "---" ]]; then
			closed=true
			break
		fi
		[[ -n "$line" && "$line" != \#* ]] || continue
		if [[ "$line" =~ ^[[:space:]] ]]; then
			continue
		fi
		if [[ ! "$line" =~ ^([a-zA-Z0-9-]+):[[:space:]]*(.*)$ ]]; then
			report_error "skills/$directory_name/SKILL.md 存在无效 frontmatter 行：$line"
			continue
		fi
		key="${BASH_REMATCH[1]}"
		value="${BASH_REMATCH[2]}"
		case "$key" in
			name|description|license|allowed-tools|metadata) ;;
			*) report_error "skills/$directory_name/SKILL.md 存在未支持的 frontmatter 字段：$key" ;;
		esac
		if [[ "$seen_keys" == *"|$key|"* ]]; then
			report_error "skills/$directory_name/SKILL.md 重复声明字段：$key"
		else
			seen_keys="${seen_keys}${key}|"
		fi
		case "$key" in
			name) declared_name="$value" ;;
			description) description="$value" ;;
		esac
	done < <(tail -n +2 "$skill_file")

	if [[ "$closed" != true ]]; then
		report_error "skills/$directory_name/SKILL.md 缺少结束 YAML frontmatter"
		return
	fi
	if [[ -z "$declared_name" ]]; then
		report_error "skills/$directory_name/SKILL.md 缺少 name"
	elif [[ ! "$declared_name" =~ ^[a-z0-9]+(-[a-z0-9]+)*$ || ${#declared_name} -gt 64 ]]; then
		report_error "skills/$directory_name 的 name 必须是不超过 64 字符的 hyphen-case"
	elif [[ "$declared_name" != "$directory_name" ]]; then
		report_error "skills/$directory_name 的 name 为 '$declared_name'，必须与目录名一致"
	fi
	if [[ -z "$description" ]]; then
		report_error "skills/$directory_name/SKILL.md 缺少 description"
	elif [[ "$description" == *"<"* || "$description" == *">"* || ${#description} -gt 1024 || "$description" == \[TODO:* ]]; then
		report_error "skills/$directory_name 的 description 不符合 Skill frontmatter 约束"
	fi
}

for skill_dir in "$root"/skills/*; do
	[[ -d "$skill_dir" ]] || continue
	name="$(basename "$skill_dir")"
	skill_file="$skill_dir/SKILL.md"
	skill_count=$((skill_count + 1))

	if [[ ! -f "$skill_file" ]]; then
		report_error "skills/$name 缺少 SKILL.md"
		continue
	fi
	check_skill_format "$skill_dir"
done

check_living_doc_index() {
	local index="$root/docs/README.md"
	local file
	local link

	if [[ ! -f "$index" ]]; then
		report_error "缺少活文档索引 docs/README.md"
		return
	fi

	while IFS= read -r file; do
		[[ -f "$root/$file" ]] || continue
		case "$file" in
			docs/*) link="${file#docs/}" ;;
			*) link="../$file" ;;
		esac
		indexed_living_count=$((indexed_living_count + 1))
		if ! grep -Fq "]($link)" "$index"; then
			report_error "$file 未收录到 docs/README.md 活文档索引"
		fi
	done < <(git -C "$root" ls-files --cached --others --exclude-standard -- \
		'docs/contracts/*.md' 'docs/design/**/*.md' 'docs/guides/*.md' \
		'backend/docs/standards/*.md' 'frontend/docs/standards/*.md' \
		'design-system/docs/*.md')
}

check_living_doc_index

if ! (cd "$root" && node ./tooling/markdown-links.ts "$root"); then
	errors=$((errors + 1))
fi

if [[ "$errors" -gt 0 ]]; then
	printf '文档机械检查失败：%d 个问题。\n' "$errors" >&2
	exit 1
fi

markdown_count="$(git -C "$root" ls-files --cached --others --exclude-standard -- '*.md' | wc -l | tr -d '[:space:]')"
printf '文档机械检查通过：%d 个 Skill，%d 个 Markdown 文件，%d 份活文档已收录。\n' "$skill_count" "$markdown_count" "$indexed_living_count"
printf '提示：本命令不判断文档语义是否与实现一致，仍须完成人工或 Agent 文档影响审查。\n'
