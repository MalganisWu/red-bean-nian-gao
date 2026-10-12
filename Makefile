# red-bean-nian-gao Makefile — TypeScript 前后端任务入口
# 用法：make <目标>，或直接 make / make help 查看所有命令

# ── 变量 ──────────────────────────────────────────────────────────────────
SDK_DIR ?= ../red-bean-qing-tuan
SDK_REPO_URL ?= https://github.com/MalganisWu/red-bean-qing-tuan.git
COMPOSE_FILE := backend/docker-compose.yml
COMPOSE_ENV_FILE ?= backend/.env.local
COMPOSE := docker compose --env-file $(COMPOSE_ENV_FILE) -f $(COMPOSE_FILE)
FRONTEND_DIR := frontend
DS_DIR := design-system
BACKEND_DIR := backend
CONTRACT_DIR := api-contract
NPM_AUDIT_REGISTRY ?= https://registry.npmjs.org
# workspace 命令始终从仓库根执行。不要先 cd 到子包：启用 pnpm 的
# manage-package-manager-versions 时，子包可能被误判为独立 workspace，继而无法解析 workspace:* 依赖。
PNPM := pnpm --filter frontend
PNPM_DS := pnpm --filter design-system
PNPM_BE := pnpm --filter @red-bean-nian-gao/backend
PNPM_CONTRACT := pnpm --filter @red-bean/api-contract

# 所有目标都是任务名而非真实文件，声明为 .PHONY 避免与同名文件冲突
.PHONY: help setup init bootstrap require-install doctor check-tools hooks-install hooks-uninstall hooks-status fmt fmt-check diff-check secrets-check compose-check lint test \
		test-integration build run dev clean infra-up infra-down infra-logs db-migrate db-status db-rollback \
		ci verify verify-quick verify-full backend-verify frontend-verify sdk-revision-check sdk-verify docs-check shared-files-check audit audit-js \
		typecheck ts-lint ts-policy-check be-architecture-check be-build be-format be-format-check be-lint be-typecheck be-test be-test-integration be-install backend-ts-verify \
		fe-dev fe-build fe-format fe-format-check fe-lint fe-typecheck fe-test fe-test-watch fe-install \
		ds-dev ds-build ds-check ds-format ds-format-check ds-lint ds-typecheck ds-install ds-test contract fe-contract full-dev \
		contract-install contract-build contract-format contract-format-check contract-lint contract-test contract-typecheck contract-verify

# ── 默认目标：显示帮助 ────────────────────────────────────────────────────
help: ## 显示所有可用命令
	@echo "red-bean-nian-gao — 可用命令："
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# ── 依赖管理 ──────────────────────────────────────────────────────────────
install: ## 安装全部 workspace 依赖（根级单 lockfile，一次覆盖四个包）
	pnpm install --frozen-lockfile

setup: install ## 兼容入口：安装全部 TypeScript package 依赖

init: ## 首次拉取仓库后的一键初始化：工具链 → Runtime SDK → 依赖 → 本地配置
	@$(MAKE) --no-print-directory doctor
	@$(MAKE) --no-print-directory bootstrap
	@if [ -d node_modules ]; then \
		echo "依赖已安装，跳过（更新依赖请执行 make install）"; \
	else \
		$(MAKE) --no-print-directory install; \
	fi
	@if [ -f "$(COMPOSE_ENV_FILE)" ]; then \
		echo "本地配置已存在，未覆盖：$(COMPOSE_ENV_FILE)"; \
	else \
		cp backend/.env.local.example "$(COMPOSE_ENV_FILE)"; \
		echo "已生成本地配置：$(COMPOSE_ENV_FILE)"; \
	fi
	@printf '\n初始化完成。还需要三步才能跑起来：\n'
	@printf '  1. 编辑 %s，填写 PostgreSQL/Redis/MinIO 密码、JWT secret 与 LLM key\n' "$(COMPOSE_ENV_FILE)"
	@printf '  2. make infra-up && make db-migrate\n'
	@printf '  3. make run（后端 :8080）与 pnpm --filter frontend dev（前端 :5173）\n'

require-install: ## 内部守卫：依赖未安装时给出可执行的提示
	@test -d node_modules || { \
		printf '未找到 node_modules。首次拉取仓库后请先执行 make init（或 pnpm install --frozen-lockfile）。\n' >&2; \
		exit 1; }

# workspace 化后 lockfile 与 node_modules 拓扑统一收归仓库根；
# 以下四个旧入口保留为别名，不再按包分目录安装。
be-install: install ## 兼容入口：workspace 内安装即根级全仓安装
fe-install: install ## 兼容入口：workspace 内安装即根级全仓安装
ds-install: install ## 兼容入口：workspace 内安装即根级全仓安装
contract-install: install ## 兼容入口：workspace 内安装即根级全仓安装

doctor: ## 检查 Node.js、pnpm 与 package 声明
	bash ./scripts/check-toolchain.sh

check-tools: doctor ## 兼容旧入口：等同 make doctor

hooks-install: ## 显式启用仓库 Git hooks（pre-commit 快检、pre-push 完整门禁）
	@current="$$(git config --local --get core.hooksPath || true)"; \
		if [ -z "$$current" ]; then \
			git config --local core.hooksPath .githooks; echo "Git hooks 已启用：.githooks"; \
		elif [ "$$current" = ".githooks" ]; then \
			echo "Git hooks 已启用：.githooks"; \
		else \
			echo "拒绝覆盖现有 hooksPath：$$current" >&2; exit 1; \
		fi

hooks-uninstall: ## 移除由本仓库安装的 Git hooks 配置
	@current="$$(git config --local --get core.hooksPath || true)"; \
		if [ "$$current" = ".githooks" ]; then \
			git config --local --unset core.hooksPath; echo "Git hooks 已停用"; \
		elif [ -n "$$current" ]; then \
			echo "未修改其他 hooksPath：$$current" >&2; exit 1; \
		else \
			echo "Git hooks 尚未启用"; \
		fi

hooks-status: ## 查看当前仓库 Git hooks 配置
	@current="$$(git config --local --get core.hooksPath || true)"; \
		if [ -n "$$current" ]; then echo "core.hooksPath=$$current"; else echo "Git hooks 尚未启用"; fi

# ── 代码质量 ──────────────────────────────────────────────────────────────
fmt: contract-format be-format fe-format ds-format ## 格式化全部 TypeScript 源码与配置

fmt-check: contract-format-check be-format-check fe-format-check ds-format-check ## 检查全部 TypeScript 格式

diff-check: ## 检查全仓已暂存和未暂存改动中的空白错误（不写文件）
	git --no-pager diff --check
	git --no-pager diff --cached --check

lint: ts-lint ## 运行全部 TypeScript Lint

# ── 测试 ──────────────────────────────────────────────────────────────────
test: be-test fe-test ds-test ## 运行全部 TypeScript 测试

test-integration: ## 强制运行真实 PostgreSQL/Redis 集成测试（依赖 infra-up）
	$(MAKE) be-test-integration

contract: contract-verify be-test fe-contract ## 校验共享契约及前后端实现

fe-contract: contract-build ## 前端契约校验（服务调用、路径常量与共享契约一致）
	$(PNPM) exec vitest run src/lib/__tests__/contract-check.test.ts

docs-check: ## 检查活文档索引、Markdown 链接/锚点与跨客户端 Skill 单一来源
	./scripts/check-docs.sh

shared-files-check: ## 检查跨仓共享件（通用规范、TS 工具链配置）与 Runtime SDK 仓一致
	node ./scripts/check-shared-files.mjs

typecheck: be-typecheck fe-typecheck ds-typecheck ## 检查全部 TypeScript package

ts-lint: be-lint fe-lint ds-lint ## 对全部 TypeScript package 执行类型感知 ESLint

ts-policy-check: ## 检查严格 TS 配置、ESLint 政策、package scripts 与 Make 入口
	node ./scripts/check-typescript-policy.mjs

secrets-check: ## 检查环境文件忽略策略与高置信度密钥
	bash ./scripts/check-secrets.sh

compose-check: ## 静态检查本地 Compose 的版本、监听地址与凭据来源
	bash ./scripts/check-compose.sh

# ── 构建 ──────────────────────────────────────────────────────────────────
build: contract-build be-build fe-build ds-build ## 构建全部 TypeScript package

# ── 运行 ──────────────────────────────────────────────────────────────────
run: be-build ## 运行 TypeScript server（等同 dev）
	$(PNPM_BE) start

dev: run ## 本地开发启动 server

clean: ## 删除构建产物与缓存
	rm -rf api-contract/dist backend/dist backend/.test-dist frontend/dist design-system/dist

# ── 基础设施（docker compose）────────────────────────────────────────────
infra-up: ## 启动 postgres / redis / minio
	@test -f "$(COMPOSE_ENV_FILE)" || { echo "缺少 $(COMPOSE_ENV_FILE)：先复制 backend/.env.local.example 并填写密码" >&2; exit 1; }
	$(COMPOSE) config --quiet
	$(COMPOSE) up -d

infra-down: ## 停止基础设施
	$(COMPOSE) down

infra-logs: ## 查看基础设施日志
	$(COMPOSE) logs -f

# ── 数据库迁移 ────────────────────────────────────────────────────────────
db-migrate: be-build ## 使用 TypeScript migrator 执行数据库迁移（up）
	$(PNPM_BE) migrate up

db-status: be-build ## 使用 TypeScript migrator 查看迁移状态
	$(PNPM_BE) migrate status

db-rollback: be-build ## 使用 TypeScript migrator 回滚上一次迁移（down）
	$(PNPM_BE) migrate down

# ── 组合命令 ──────────────────────────────────────────────────────────────
backend-ts-verify: contract-verify be-architecture-check be-format-check be-typecheck be-lint be-test be-build ## TypeScript 后端完整门禁

be-test-integration: ## 强制运行 TypeScript PostgreSQL、Redis、MinIO 与完整应用集成测试
	@test -f "$(COMPOSE_ENV_FILE)" || { echo "缺少 $(COMPOSE_ENV_FILE)：真实集成测试从该文件读取本地基础设施凭据" >&2; exit 1; }
	RBNG_INTEGRATION_REQUIRED=1 RBNG_COMPOSE_ENV_FILE="$(abspath $(COMPOSE_ENV_FILE))" $(PNPM_BE) test:integration

backend-verify: backend-ts-verify ## TypeScript 后端完整门禁

frontend-verify: contract-verify fe-format-check fe-typecheck fe-lint fe-test fe-build ## 前端完整门禁（fe-test 已覆盖契约测试）

bootstrap: ## 克隆同级 Runtime SDK、检出 runtime.lock 版本并构建它（首次拿到产品仓后执行一次）
	@lock="$$(cat runtime.lock)"; \
	need_build=0; \
	checkout_locked() { \
		git -C "$(SDK_DIR)" checkout --quiet --detach "$$lock" \
			|| { echo "无法检出 $$lock —— 该版本可能还没推送到 $(SDK_REPO_URL)" >&2; exit 1; }; \
	}; \
	if [ -d "$(SDK_DIR)/.git" ]; then \
		current="$$(git -C "$(SDK_DIR)" rev-parse HEAD 2>/dev/null || true)"; \
		if [ "$$current" = "$$lock" ]; then \
			echo "Runtime SDK 已在 runtime.lock 锁定的版本：$$lock"; \
		else \
			echo "Runtime SDK 位于 $$current，切到 runtime.lock：$$lock"; \
			checkout_locked; need_build=1; \
		fi; \
	else \
		echo "克隆 Runtime SDK → $(SDK_DIR)"; \
		git clone --quiet "$(SDK_REPO_URL)" "$(SDK_DIR)"; \
		checkout_locked; need_build=1; \
	fi; \
	[ -f "$(SDK_DIR)/dist/index.js" ] || need_build=1; \
	if [ "$$need_build" = 1 ]; then \
		echo "构建 Runtime SDK —— 后端以 link: 消费它，exports 指向 dist/"; \
		$(MAKE) --no-print-directory -C $(SDK_DIR) setup; \
		$(MAKE) --no-print-directory -C $(SDK_DIR) ts-build; \
	else \
		echo "Runtime SDK 已构建：$(SDK_DIR)/dist"; \
	fi
	@$(MAKE) --no-print-directory sdk-revision-check

sdk-revision-check: ## 核对同级 Runtime SDK 与 runtime.lock 一致且工作区干净
	./scripts/check-runtime-revision.sh "$(SDK_DIR)" runtime.lock

sdk-verify: sdk-revision-check ## 验证锁定版本的同级 Runtime SDK（SDK_DIR 可覆盖）
	@test -f "$(SDK_DIR)/package.json" || { \
		echo "找不到 Runtime SDK：$(SDK_DIR)" >&2; \
		echo "先执行 make bootstrap 克隆并锁定它，或用 SDK_DIR=<路径> 指向已有工作区。" >&2; \
		exit 1; }
	$(MAKE) -C $(SDK_DIR) verify

verify: require-install doctor diff-check docs-check shared-files-check secrets-check compose-check ts-policy-check backend-verify frontend-verify ds-check sdk-verify ## 本地统一门禁（不改 Git 跟踪文件、不要求外部服务）

verify-quick: require-install doctor diff-check docs-check shared-files-check secrets-check compose-check ts-policy-check be-architecture-check fmt-check ## commit 前快速门禁（不改 Git 跟踪文件）

verify-full: verify test-integration audit ## 发布级门禁（额外要求基础设施、网络和安全审计工具）

ci: verify ## 兼容旧入口：等同 make verify

audit: audit-js ## 独立 TypeScript 生产依赖安全审计（需要网络）

audit-js: ## 扫描全部 workspace 生产依赖漏洞（单次覆盖四包）
	pnpm audit --registry=$(NPM_AUDIT_REGISTRY) --prod --audit-level high

# ── TypeScript 后端命令 ────────────────────────────────────────────────────
be-architecture-check: ## 快速检查后端分层边界、显式实现与 Module 循环依赖
	$(PNPM_BE) architecture:check

be-build: contract-build ## 构建 TypeScript 后端
	$(PNPM_BE) build

be-format: ## 格式化 TypeScript 后端源码与配置
	$(PNPM_BE) format

be-format-check: ## 检查 TypeScript 后端格式（不写文件）
	$(PNPM_BE) format:check

be-lint: ## TypeScript 后端类型感知 ESLint
	$(PNPM_BE) lint

be-typecheck: contract-build ## TypeScript 后端严格类型检查
	$(PNPM_BE) typecheck

be-test: contract-build ## 运行 TypeScript 后端测试
	$(PNPM_BE) test

# ── 前端命令 ──────────────────────────────────────────────────────────────
fe-dev: ## 启动前端开发服务器（0.0.0.0:5173，支持远程 SSH 访问）
	$(PNPM) dev --host 0.0.0.0

fe-build: contract-build ## 构建前端产物
	$(PNPM) build

fe-format: ## 使用 Prettier 格式化前端源码与配置
	$(PNPM) format

fe-format-check: ## 使用 Prettier 检查前端源码与配置（不写文件）
	$(PNPM) format:check

fe-lint: ## 前端代码检查
	$(PNPM) lint

fe-typecheck: contract-build ## 前端类型检查
	$(PNPM) typecheck

fe-test: contract-build ## 运行前端测试
	$(PNPM) test

fe-test-watch: ## 前端测试（watch 模式）
	$(PNPM) test:watch

# ── 前后端共享 API 契约 ───────────────────────────────────────────────────
contract-build: ## 构建共享 API 契约（前后端构建前置条件）
	$(PNPM_CONTRACT) build

contract-format: ## 格式化共享 API 契约源码
	$(PNPM_CONTRACT) format

contract-format-check: ## 检查共享 API 契约格式（不写文件）
	$(PNPM_CONTRACT) format:check

contract-typecheck: ## 检查共享 API 契约类型
	$(PNPM_CONTRACT) typecheck

contract-lint: ## 检查共享 API 契约源码
	$(PNPM_CONTRACT) lint

contract-test: ## 运行共享 API 契约测试
	$(PNPM_CONTRACT) test

contract-route-check: contract-test ## 校验端点目录无静态/参数段同深度共存且无重复注册
	node ./scripts/check-route-collisions.mjs

contract-verify: contract-format-check contract-typecheck contract-lint contract-test contract-route-check ## 验证共享 API 契约

# ── Design System 命令 ───────────────────────────────────────────────────
ds-dev: ## 启动 Design System 开发服务器（localhost:5174）
	$(PNPM_DS) dev

ds-build: ## 构建 Design System 静态产物
	$(PNPM_DS) build

ds-format: ## 格式化 Design System 源码
	$(PNPM_DS) format

ds-format-check: ## 使用 Prettier 检查 Design System 源码（不写文件）
	$(PNPM_DS) format:check

ds-lint: ## Design System 类型感知 ESLint
	$(PNPM_DS) lint

ds-typecheck: ## Design System TypeScript 严格类型检查
	$(PNPM_DS) typecheck

ds-test: ## 运行 Design System 组件交互测试
	$(PNPM_DS) test

ds-check: ## Design System 质量检查（lint + format + typecheck + build）
	$(PNPM_DS) ai:check

# ── 前后端联合启动 ────────────────────────────────────────────────────────
full-dev: ## 同时启动后端 + 前端（后端 8080，前端 5173）
	@echo "启动后端..."
	@$(PNPM_BE) dev &
	@echo "启动前端..."
	@$(PNPM) dev
	@wait
