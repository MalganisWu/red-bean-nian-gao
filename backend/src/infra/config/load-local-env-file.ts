import { config as loadDotenv } from 'dotenv'

/**
 * 本地配置单源：把 `backend/.env.local` 注入 `process.env`。
 *
 * - **不覆盖已存在的环境变量**（dotenv 默认行为）：部署平台注入的值优先，本地文件只是兜底。
 *   这也是生产可以不提供该文件的原因。
 * - **文件不存在即无操作**：生产与纯环境变量运行都不需要它，缺失不是错误。
 * - 只在**进程入口**调用：`config.ts` 保持「读 YAML + 读传入 environment」的纯职责，测试不触碰真实文件。
 */
export function loadLocalEnvFile(directory: string): void {
  loadDotenv({ path: `${directory}/.env.local`, override: false, quiet: true })
}
