import {
  ApplyPatchTool,
  EditFileTool,
  GlobTool,
  GrepTool,
  ListDirectoryTool,
  MemoryFileReadLedger,
  ShellTool,
  TodoWriteTool,
  UnrestrictedReadTool,
  WriteFileTool,
} from 'red-bean-qing-tuan/tools'
import type { FileReadLedger, Tool } from 'red-bean-qing-tuan/tools'

/**
 * 组装产品显式选择的 Runtime 工具（文件、规划与命令执行）。
 *
 * 这些工具属于 Runtime 内置能力，必须由宿主显式选择才会进入 Registry；本函数是产品侧唯一的
 * 选择点，`runtimeBuiltinProvider` 只负责把结果注册进去。
 *
 * 关键约束：读取工具与写入工具必须共用**同一个**读取账本。写入类工具用账本判断「当前会话是否
 * 读过该文件、读到的是哪个版本」，而读写是各自独立的实例——每个工具自建账本会让「先读后写」
 * 闸门永远读不到读取记录，从而静默失去保护。因此账本在这里创建一次并向两侧注入。
 *
 * 这些工具都不限制路径，只在部署平台已提供文件系统沙箱时才是安全的；产品由部署者自持，Agent
 * 需要通读宿主机文件才能完成真实的代码与配置任务，代价与边界见
 * `docs/decisions/2026-09-17-unrestricted-agent-file-read.md`。
 *
 * `sys_shell` 是任意命令执行：它会发起网络请求、安装依赖、启动进程，并且**绕过全部文件闸门**
 * （`sed -i`、`tee` 都不经过读取账本），因此「先读后写」在本工具可用时只剩引导作用而非强制约束。
 * 子进程继承宿主进程的完整环境变量，包括部署凭据。是否给某个 Agent 开这个口子，由 `sys_tool_ids`
 * 单独决定。
 *
 * 新增工具只注册、不自动授权：是否可达由各 Agent 的 `sys_tool_ids` 决定，默认 Agent 不获得。
 * @returns 本次新建的工具实例，已共享同一个读取账本；每次调用都是独立的一份，不要跨实例复用
 */
export function createHostTools(): readonly Tool[] {
  const ledger: FileReadLedger = new MemoryFileReadLedger()
  return [
    new UnrestrictedReadTool(ledger),
    new ListDirectoryTool(),
    new GlobTool(),
    new GrepTool(),
    new WriteFileTool({ ledger }),
    new EditFileTool({ ledger }),
    new ApplyPatchTool({ ledger }),
    new TodoWriteTool(),
    new ShellTool(),
  ]
}
