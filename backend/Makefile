# backend/Makefile — 转发到根 Makefile
# 根 Makefile 是唯一入口，各 TypeScript 包都由 workspace 根通过 `pnpm --filter` 调用。
# 因此 `cd backend && make <目标>` 与在仓库根执行 `make <目标>` 等价。
# 用法：cd backend && make run / test / infra-up / ...

%:
	@$(MAKE) -C .. $@

.PHONY: help
help:
	@$(MAKE) -C .. help
