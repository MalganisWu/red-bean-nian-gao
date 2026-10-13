import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 跨仓共享件的一致性检查。
//
// 两仓（本仓与 Runtime SDK 仓 red-bean-qing-tuan）各存一份通用规范件与 TypeScript 工具链配置，
// 它们必须保持同步。本脚本与产品仓中的同名脚本逐字一致，且不写死「哪一仓是兄弟」，
// 因此同一份代码在两仓都能跑。
//
// 比对照两类：
// - 逐字相同：文档与 JSON 配置。两仓 prettier 配置不同（产品仓 singleQuote），因此只有
//   不被格式化器改写、或两仓格式化结果本就一致的文件才放进这一类。
// - 语义相同：policy.mjs 导出的是规则表，两仓可通过不同书写风格表达同一组规则；比对导出值
//   比比对字节更稳。每仓特有的 requiredPackageScripts 明确排除在外。

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const selfName = path.basename(root);
const candidates = ["red-bean-qing-tuan", "red-bean-nian-gao"];

/** 必须逐字相同的文件。 */
const byteIdenticalFiles = [
  "docs/standards/typescript-common-conventions.md",
  "tooling/typescript/tsconfig.base.json",
  "tooling/typescript/export-jsdoc-rules.mjs",
  "tooling/typescript/export-jsdoc-cases.json",
  "scripts/check-shared-files.mjs",
];

/** 必须语义相同的模块；列表内是允许各仓不同的导出名。 */
const semanticModules = [
  {
    file: "tooling/typescript/policy.mjs",
    perRepositoryExports: ["requiredPackageScripts"],
  },
];

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
      });
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const failures = [];
let sibling = undefined;
for (const name of candidates) {
  if (name === selfName) continue;
  const candidate = path.resolve(root, "..", name);
  if (candidate === root || !(await exists(path.join(candidate, ".git"))))
    continue;
  sibling = candidate;
  break;
}

if (sibling === undefined) {
  console.log("未找到兄弟仓工作区，跳过共享件一致性检查。");
  process.exit(0);
}

for (const relative of byteIdenticalFiles) {
  const mine = await readIfExists(path.join(root, relative));
  const theirs = await readIfExists(path.join(sibling, relative));
  if (mine === undefined) {
    failures.push(`本仓缺少共享件：${relative}`);
    continue;
  }
  if (theirs === undefined) {
    failures.push(`兄弟仓缺少共享件：${relative}`);
    continue;
  }
  if (mine !== theirs) {
    failures.push(`${relative} 与兄弟仓不逐字相同`);
  }
}

for (const { file, perRepositoryExports } of semanticModules) {
  const mine = await importModule(path.join(root, file));
  const theirs = await importModule(path.join(sibling, file));
  if (mine === undefined || theirs === undefined) {
    failures.push(`${file} 在某一仓不存在，无法比对`);
    continue;
  }
  const names = new Set([...Object.keys(mine), ...Object.keys(theirs)]);
  for (const name of names) {
    if (perRepositoryExports.includes(name)) continue;
    const left = stableStringify(mine[name]);
    const right = stableStringify(theirs[name]);
    if (left !== right) {
      failures.push(`${file} 导出的 ${name} 与兄弟仓不一致`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`✗ ${failure}`);
  }
  console.error(
    "共享件必须两仓一致。先改上游并提交，再在本仓 bump 依赖锁定时同步；不要只改一边。",
  );
  process.exit(1);
}

console.log(
  `✓ 与 ${path.basename(sibling)} 的 ${String(byteIdenticalFiles.length)} 个共享件逐字一致、` +
    `${String(semanticModules.length)} 个规则模块语义一致。`,
);

/** 路径存在即可（文件或目录）：`.git` 在普通仓库里是目录，在 worktree 里是文件。 */
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function readIfExists(target) {
  try {
    return await readFile(target, "utf8");
  } catch {
    return undefined;
  }
}

async function importModule(target) {
  if (!(await exists(target))) return undefined;
  const module = await import(pathToFileURL(target).href);
  return Object.fromEntries(Object.entries(module));
}
