/**
 * 导出符号 JSDoc 门禁的**纯规则层**（跨仓共享件，两仓逐字节相同）。
 *
 * 这里刻意**不 import `typescript`**：产品仓没有根 `package.json`，仓库根解析不到
 * 编译器 API，而共享件必须是逐字节相同的同一份文件。所以分层与 `architecture-syntax.mjs`
 * 一致 —— 语法层（碰编译器、每仓一份）产出中性记录，本文件只消费记录、产出违规。
 * 新增语法形态只需改语法层；改判据只需改本文件。
 *
 * 判据的唯一事实来源是**跨仓共享的通用 TypeScript 规范**——入口是
 * `docs/standards/typescript-common-conventions.md`（短指针，实体在 `skills/` 下的编码规范 Skill）。
 * 门禁只负责**可机械判定**的部分：有没有注释、tag 与签名是否对应、说明是否中文。
 * 「注释是否解释了复杂业务」不可机械判定，不在这里，也不假装在这里。
 */

/** 违规种类；跨仓同名规则共用这些字符串，改名要两仓同步。 */
export const EXPORT_JSDOC_RULES = Object.freeze({
  /** 整个 JSDoc 块都不存在。 */
  MISSING_JSDOC: "missing-jsdoc",
  /** 有 JSDoc 块，但描述正文为空（只有 tag）。 */
  UNDESCRIBED: "undescribed",
  /** 缺少某个参数的 `@param`。 */
  MISSING_PARAM: "missing-param",
  /** 非 void 返回缺少 `@returns`。 */
  MISSING_RETURNS: "missing-returns",
  /** 参数是解构模式，门禁要求简单标识符以便 `@param` 具名。 */
  DESTRUCTURED_PARAM: "destructured-param",
  /** 写了签名里不存在的参数 tag。 */
  STALE_TAG: "stale-tag",
  /** 描述正文或 tag 说明不含中文。 */
  NON_CHINESE: "non-chinese-jsdoc",
});

/**
 * 中文字符判据。
 *
 * 依据是**中文是主要工作语言**：用中文写注释降低阅读与评审时的认知负担，纯英文注释会给读者
 * 平添一次语言切换。这条比「统一用简体中文」的书写要求窄 —— 它只要求**含**中文，不判断是否
 * 混排、也不审英文残留的质量。
 */
const CHINESE_CHARACTER = /[㐀-鿿]/u;

/**
 * 判定一个中性记录的违规。
 *
 * `record` 的字段见 `architecture-syntax.mjs#collectDocumentables`：
 * `{ symbolPath, kind, exported, jsdocText, params, hasDestructuredParam, returnTypeText }`。
 * 返回 `[{ rule, param? }]`，**不含文件名** —— 文件名由入口脚本在报告时补齐。
 */
export function documentableViolations(record) {
  // 不对 `record.exported` 过滤：判据是**可见范围是否跨过函数体边界**，与是否导出无关
  // （见共享规范「注释 · 谁必须有注释」）。语法层仍产出 `exported` 作为事实字段，此处不用。
  //
  // 构造函数整体豁免：它既不是方法也不是访问器或属性，而它的契约（依赖清单）在
  // 组装入口比在类里更可读。参考实现同样豁免构造器。语法层仍然产出 ctor 记录，
  // 保留未来收紧的余地 —— 豁免是策略，属于本文件；产出事实是语法层的职责。
  if (record.kind === "ctor") return [];
  const jsdocText = record.jsdocText ?? "";
  if (jsdocText.trim() === "") {
    // 整块缺失时只报一条：再叠上缺 tag 会让一个符号产出三条基线条目，
    // 既虚高计数，也让「补一个块」这件事在 diff 里看不出收益。
    return [{ rule: EXPORT_JSDOC_RULES.MISSING_JSDOC }];
  }
  const block = parseJsDocBlock(jsdocText);
  // `@internal` 是显式豁免：作者声明该符号不属于对外契约。
  if (block.tags.some((tag) => tag.name === "internal")) return [];

  const violations = [];
  const hasDescription = block.description !== "";
  if (!hasDescription || hasEmptyTagDoc(block)) {
    violations.push({ rule: EXPORT_JSDOC_RULES.UNDESCRIBED });
  }
  // 「空说明」与「不是中文」互斥：没写的报 undescribed，写了的但不是中文才报 non-chinese。
  if (hasDescription && hasNonChineseDoc(block)) {
    violations.push({ rule: EXPORT_JSDOC_RULES.NON_CHINESE });
  }

  const documented = collectParamTags(block);
  if (requiresParams(record)) {
    if (record.hasDestructuredParam === true) {
      violations.push({ rule: EXPORT_JSDOC_RULES.DESTRUCTURED_PARAM });
    }
    for (const name of record.params ?? []) {
      if (!documented.params.has(name)) {
        violations.push({
          rule: EXPORT_JSDOC_RULES.MISSING_PARAM,
          param: name,
        });
      }
    }
  }
  // 解构参数的记录里 `params` 为空，此时无法判断 tag 是否陈旧，跳过而不是误报。
  if (record.hasDestructuredParam !== true) {
    for (const name of documented.params.keys()) {
      if (!(record.params ?? []).includes(name)) {
        violations.push({ rule: EXPORT_JSDOC_RULES.STALE_TAG, param: name });
      }
    }
  }
  if (requiresReturns(record) && !documented.hasReturns) {
    violations.push({ rule: EXPORT_JSDOC_RULES.MISSING_RETURNS });
  }
  return violations;
}

/**
 * 需要逐参数 `@param` 的种类。
 *
 * 访问器按 `symbolPath` 的 `#set` 后缀区分：语法层给 getter/setter 生成
 * `<类>.<成员>#get` 与 `#set`，两者同名也不可能互相冲突。
 */
function requiresParams(record) {
  if (isSetter(record)) return true;
  return record.kind === "function" || record.kind === "method";
}

/**
 * 需要 `@returns` 的种类。
 *
 * **fail-open**：只在声明了显式返回类型、且该类型不是 void 类时才要求。
 * 没写返回类型就不要求 —— 否则本门禁会顺带变成「先补返回类型标注」的连锁改造，
 * 而在两个前端 workspace 里 `explicit-module-boundary-types` 是关闭的。
 * 构造函数与 setter 没有返回值，不要 `@returns`。
 */
function requiresReturns(record) {
  if (isSetter(record)) return false;
  const returnsSomething =
    record.kind === "function" || record.kind === "method" || isGetter(record);
  if (!returnsSomething) return false;
  const returnTypeText = record.returnTypeText;
  return returnTypeText !== undefined && !isVoidLike(returnTypeText);
}

function isGetter(record) {
  return record.kind === "accessor" && record.symbolPath.endsWith("#get");
}

function isSetter(record) {
  return record.kind === "accessor" && record.symbolPath.endsWith("#set");
}

/**
 * `void` / `never` / `undefined` 及其 `Promise<>` 包装视为无返回值。
 *
 * 按 `|` 拆开逐个判定，这样 `Promise<void> | void` 这类联合也算 void —— 只精确匹配四个
 * 字符串会把它们判成「有返回值」，逼作者给一个语义为空的函数补 `@returns`，那正是
 * 门禁自己制造低信息量 tag 的方式。
 */
function isVoidLike(returnTypeText) {
  return returnTypeText.replace(/\s+/gu, "").split("|").every(isVoidAtom);
}

function isVoidAtom(atom) {
  // `asserts x is T` 是断言签名：它没有返回值（不是 `x is T` 那种返回 boolean 的类型谓词）。
  if (atom.startsWith("asserts ")) return true;
  const inner =
    atom.startsWith("Promise<") && atom.endsWith(">")
      ? atom.slice(8, -1)
      : atom;
  return inner === "void" || inner === "never" || inner === "undefined";
}

/**
 * 把 JSDoc 原文拆成「描述正文 + tag 列表」。
 *
 * 只做门禁判定需要的解析，不追求完整 JSDoc 语法：`@tag` 行开启一个 tag，后续行
 * 追加到该 tag 的文本；首个 tag 之前的非空文本是描述正文。
 */
function parseJsDocBlock(jsdocText) {
  const body = jsdocText.replace(/^\/\*\*/u, "").replace(/\*\/\s*$/u, "");
  const description = [];
  const tags = [];
  let current;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/^\s*\*?\s?/u, "");
    const match = /^@(\w+)\b(.*)$/u.exec(line.trim());
    if (match !== null) {
      current = { name: match[1], text: match[2].trim() };
      tags.push(current);
      continue;
    }
    if (current === undefined) description.push(line);
    else current.text = `${current.text} ${line.trim()}`.trim();
  }
  return { description: description.join("\n").trim(), tags };
}

/** 描述正文或 `@param` / `@returns` 的说明是否缺中文。 */
function hasNonChineseDoc(block) {
  if (!CHINESE_CHARACTER.test(block.description)) return true;
  return documentedTagTexts(block).some(
    (text) => !CHINESE_CHARACTER.test(text),
  );
}

/** 是否存在只有 tag 名、没有说明的 `@param` / `@returns`。 */
function hasEmptyTagDoc(block) {
  return documentedTagTexts(block).some((text) => text === "");
}

/**
 * 取出「其说明应当是散文」的 tag 的说明部分。
 *
 * `@param` 先剥掉 `{类型}` 与参数名，`@returns` 取全文。**只查这两类**：其它 tag
 * （`@throws`、`@example`、`@internal`…）的文本可能是纯标识符或代码片段，强制中文会误报。
 */
function documentedTagTexts(block) {
  const texts = [];
  for (const tag of block.tags) {
    if (tag.name === "returns" || tag.name === "return") {
      texts.push(tag.text.trim());
      continue;
    }
    if (tag.name !== "param") continue;
    texts.push(
      tag.text
        .replace(/^\{[^}]*\}\s*/u, "")
        .replace(/^(\[[^\]]+\]|[A-Za-z_$][\w$]*)/u, "")
        .replace(/^\s*-\s*/u, "")
        .trim(),
    );
  }
  return texts;
}

/** 收集 `@param` 与 `@returns`，参数按名字建索引。 */
function collectParamTags(block) {
  const params = new Map();
  let hasReturns = false;
  for (const tag of block.tags) {
    if (tag.name === "param") {
      const name = paramTagName(tag.text);
      if (name !== undefined) params.set(name, tag.text);
      continue;
    }
    if (tag.name === "returns" || tag.name === "return") hasReturns = true;
  }
  return { params, hasReturns };
}

/**
 * 从 `@param` 的文本里取参数名。
 *
 * 支持三种常见写法：`name 说明`、`name - 说明`、`{Type} name 说明`；
 * 也接受 JSDoc 的可选参数写法 `[name]` / `[name=默认值]`。
 */
function paramTagName(tagText) {
  const withoutType = tagText.replace(/^\{[^}]*\}\s*/u, "");
  const match = /^(\[[^\]]+\]|[A-Za-z_$][\w$]*)/u.exec(withoutType);
  if (match === null) return undefined;
  return match[1].replace(/^\[/u, "").replace(/\]$/u, "").replace(/=.*$/u, "");
}
