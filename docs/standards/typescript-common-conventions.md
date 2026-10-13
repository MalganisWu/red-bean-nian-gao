# TypeScript 通用编码规范

> 文档性质：活文档，且是**跨仓共享件**。本文件与 `red-bean-nian-gao` 中的同名文件逐字相同，
> 由一致性门禁校验；修改必须两仓同步（见「跨仓一致性」）。
> 本仓特有的规则写在同目录的 [`typescript-coding-conventions.md`](typescript-coding-conventions.md)，
> 两者冲突时以本文件的通用规则为准，本仓特有规则只做补充。

## 设计目标

TypeScript 用于减少人工的类型翻译，不用于把复杂度隐藏在类型体操、框架反射或隐式 JavaScript 行为中。
代码必须同时让编译器、开发者和 AI 审查者能够追踪数据来源、失败路径与依赖关系。

## 类型标注边界

必须显式标注：

- 导出函数、公开方法和跨模块回调的参数与返回值。
- 协议边界：API、SSE、Tool 参数与结果、Checkpoint、持久化和环境配置。
- 类的公开字段、构造函数依赖，以及不能从右侧一眼确认的复杂对象。
- 作为协议实现的对象使用显式类型或 `satisfies` 校验。

简单局部常量和已经由声明位置完整约束的回调允许推导。禁止为了形式重复信息：

```ts
const retryCount = 3;
const labels = ["running", "completed"] as const;
```

为满足接口形状而保留但确实不使用的参数以 `_` 开头；其余未使用变量仍由编译器和 ESLint 拒绝。

## 硬性禁止

- 生产代码与测试代码不得使用显式 `any`；未知输入从 `unknown` 开始窄化。
- 禁止 `@ts-ignore`；`@ts-expect-error` 仅限类型契约测试，必须写明原因。
- 禁止非空断言 `value!` 和双重断言 `value as unknown as Target`。
- 禁止用 `as Target` 代替外部数据校验；`as const` 与经过验证的测试替身不属于此类。
- 禁止 `enum`、运行时代码 namespace、参数属性、Decorator 与 Reflect Metadata。
- 禁止 `eval`、原型修改、Monkey Patch 和依赖运行期扫描的自动注入。
- 禁止 `==`、`!=` 和 `!!value` 等隐式强制转换。惯用的存在性判断可以保留，但涉及空字符串、零值
  与缺失值具有不同业务含义时必须显式比较。
- 禁止浮空 Promise、把异步函数误传给同步回调，以及静默吞掉异步错误。
- 禁止通过放宽 `tsconfig`、关闭整份 ESLint 文件或降低规则级别绕过门禁。
- 错误码、状态码、事件类型、命令 kind 等字面量联合的**比较与 case 标签必须引用 const 成员**
  （`CODE.X`、`EVENT_TYPES.Y`），禁止直接写字符串字面量；字面量联合如无 const 源，先为它建立
  const 映射。理由：成员引用让 IDE 的 Go to Definition / Find Usages 在定义与全部使用点之间
  双向可跳，并防止拼写漂移。
- 禁止把外部协议的字符串常量误映射到本仓自建的状态联合：即使取值同名（如都叫 `'completed'`），
  只要属于不同域，就必须各自引用各自的 const 源。

## 外部输入

TypeScript 类型在运行时不存在。HTTP body、SSE、数据库 JSON、缓存、环境变量、LLM 输出和 Tool
参数必须在进入可信领域前经过运行时 Schema 校验。禁止直接断言：

```ts
// 禁止
const payload = JSON.parse(raw) as ToolPayload;

// 正确方向；具体 Schema 库由各仓自行决定
const rawPayload: unknown = JSON.parse(raw);
const payload = ToolPayloadSchema.parse(rawPayload);
```

校验完成后的领域代码不应反复解析同一数据。API 静态类型、路由、错误码与运行时守卫必须来自机器
可执行的唯一契约源，公开 Markdown 文档只是它的同步投影。

## 泛型

- 泛型必须表达两个及以上位置之间的真实类型关系；只出现一次的类型参数改用具体类型或 `unknown`。
- 通常最多两个类型参数，并使用 `TInput`、`TOutput`、`TEvent` 等语义名称。
- 优先使用判别联合和显式接口，不用重载、深层条件类型或递归映射类型隐藏流程。
- 复杂类型工具仅允许位于约定核心层或 tooling，并必须有类型级测试和用途说明。
- 不使用泛型默认值隐藏调用方必须理解的行为。

## 控制流与错误

- 联合类型使用判别字段，并对 `switch` 做穷尽检查。
- 数组或索引访问始终按「可能不存在」处理；先检查再使用。
- 可选字段的「缺失」与「显式 `undefined`」语义不同，不混用。
- `catch` 值视为 `unknown`，通过 `instanceof Error` 或领域解析器窄化。
- 领域错误使用稳定 code 或判别联合；不依赖动态错误文本分支。
- 错误包装必须保留 cause 链（`new Error(message, { cause })`），不得只取 `message` 重抛使日志与
  观测断链。错误分类（码 / kind）服务于契约，错误链（cause）服务于可定位性，两者缺一不可。
- 领域错误类型可以按层共存，关键是 cause 链不断；可定位性优先于类型纯度。

## 函数与流程可读性

流程要能顺着读。**一个函数只做一件能用一句话讲完的事**：多写几行局部变量和具名函数，不要把查找、
判断、转换挤在同一个表达式里。

箭头函数只在**同时**满足下面三条时使用：

- 函数体只有一行。
- 不使用外部变量，或只使用一眼能看懂的那一个。
- 不承担流程控制。

下列情况一律写成有名字的函数：

- 函数体超过一行。
- 函数在以后才被调用，并记住了外部变量（订阅、定时器、事件总线、被替换的 handler）。
- 递归、中间件、重试、取消。
- 回调内部还有 `if`、循环或另一个回调。

容器回调不套两层：`map` / `filter` / `some` / `find` 里再嵌一层容器调用时，把内层抽成具名判断
函数，或改用 `for` 循环。

```ts
// 禁止：判断藏在两层回调里
const interrupting = calls.filter((call) =>
  tools.some(
    (tool) => tool.function.name === call.function.name && tool.interrupting === true,
  ),
);

// 正确：内层有名字，调用点一眼读完
function isInterrupting(call: ToolCall): boolean {
  for (const tool of tools) {
    if (tool.function.name === call.function.name && tool.interrupting === true) {
      return true;
    }
  }
  return false;
}

const interrupting = calls.filter((call) => isInterrupting(call));
```

抽出来的函数放在它被使用的那一层旁边，不要提升到与调用点无关的层级。

### 中间件与流程组装

不要用循环里的匿名函数层层替换 handler。**「包一层」这个动作必须有名字**，否则读者无法指出
哪一行在进入下一层、哪一行在开始执行。

```ts
// 禁止：洋葱结构藏在赋值里
let handler = finalHandler;
for (let index = middleware.length - 1; index >= 0; index -= 1) {
  const next = handler;
  handler = (nextSignal) => middleware[index](info, next, nextSignal);
}
return handler(signal);

// 正确：能叫出名字的 dispatch，表示「执行第几层」
function dispatch(index: number, signal: AbortSignal): Promise<RuntimeResult> {
  const current = middleware[index];
  if (current === undefined) return finalHandler(signal);

  function runNext(nextSignal: AbortSignal): Promise<RuntimeResult> {
    return dispatch(index + 1, nextSignal);
  }

  return current(info, runNext, signal);
}

return dispatch(0, signal);
```

两类写法做的是同一件事，差别只在能不能顺着读。递归、重试、取消重入同理：**层与层之间的跳转
要有一行代码看得见**。

类方法如果要交给别人稍后调用、且内部要用 `this`，可以保留箭头函数，但先放进一个有名字的局部变量：

```ts
const runRequest = (signal: AbortSignal): Promise<RuntimeResult> =>
  this.#runRequest(request, signal);

return runWithMiddleware(info, middleware, runRequest, signal);
```

## 表达式与调用可读性

- **禁止调用点现场组装复杂参数**：方法调用需要多字段对象（约 4 个字段以上）、SQL 绑定数组或 DTO
  时，先在调用处上方构建为具名局部变量再传入——变量名即入参语义文档，调用点必须一眼能读完。
  禁止「DTO 刚组装又解包成位置参数」「调用 a 时才现拼 b 对象」等让参数意义悬空的写法。
  同一结构在多处组装时抽具名小函数，消除双路漂移。
- **三元表达式收敛**：禁止嵌套三元、参数内联三元与 `...(cond ? {} : { field })` 条件展开三分；
  多分支用提前 return 或 if/else。单个三元仅允许表达简单二选一且结果一眼可读。

## 判空与可空映射

- 可空字段的判空写法同仓内统一：按字段的实际类型选用一种语义并写全（`=== null` 或
  `=== undefined`），禁止三种写法（`=== null` / `=== undefined` / `=== ''`）混用；
  `=== ''` 仅用于业务语义确实是「空字符串」的判定，不作为「缺失」的替代。
- 空值到 DTO 或参数的映射使用共享具名助手（如 `optionalField(key, value)`），不逐处展开
  `...(cond ? {} : { field })`。

## 命名与签名约定

- 命名反映真实职责：类名不与真实职责互骗，避免误导性前缀，同一隐语不在多层指不同概念。
- 导入别名不得造成同名双定义。
- 同类操作的参数按「所有者 / 作用域在前」统一排序；跨层复制签名时保持同一参数序，并用测试锁住，
  防止静默带偏。
- 私有成员统一使用 `#` 前缀（运行时真私有），不混写 TypeScript `private` 修饰符。

## 依赖、接口与实现

- 依赖通过构造函数或显式工厂传入，不使用 Service Locator、全局可变注册表或隐式容器。
- 业务代码依赖中性接口；框架对象留在各自的基础设施适配层。
- 接口只服务于真实的多实现、宿主替换或公开契约边界；内部 1:1 且无替换需求的能力接口不建接口，
  调用方直接依赖实现类。
- 生产实现类必须显式 `implements` 对应接口，不能只依靠 TypeScript 结构化类型兼容。
- 工厂返回协议对象时必须声明返回类型或使用 `satisfies`。
- 注入型行为接口使用职责后缀（`Repository`、`Adapter`、`Store`、`Registry`、`Dispatcher`、
  `Factory`、`Hook`、`Tracer`、`Loader`、`Runner`、`Collector` 等已表达 Port 语义，不机械追加
  `Port`）；含糊的接口命名为 `*ServicePort`，不得只命名为 `*Service`。
- 默认实现必须在组装入口以明确的 `new ConcreteClass(...)` 绑定；生产默认实现不得藏在匿名对象、
  模块副作用或运行期扫描中。测试替身可以使用对象字面量，但必须接受显式接口类型约束。
- 实现类以「公开方法串联私有小方法」组织，保证一个方法能读完完整流程；行数红线服从该验收标准
  （可读性优先于机械行数）。
- 模块依赖保持单向，禁止用 barrel file 掩盖循环依赖。
- 不为减少几行样板引入 Decorator、代码扫描或运行期注册魔法。
- 人工审查依赖时按「依赖字段 → 接口 → implements → 组装入口中的 `new` → 实现方法」追踪。
  调用处不直接 `new` 是构造注入的预期结果，组装入口必须补足实现选择的证据链。

## 中文注释

- 生产代码注释与 JSDoc 使用简体中文，专有协议名和代码标识保留原文。
- 面向用户或日志的错误消息使用简体中文，协议名词与代码标识保留原文；残留英文错误消息属于缺陷
  而非风格偏好。
- 公开入口、DTO、接口、默认实现、复杂状态机、并发与一致性、安全限制和反直觉分支必须解释设计
  意图、所有权或失败语义。
- 注释说明「为什么」和边界，不逐行复述显而易见的代码；实现变化时同步更新或删除失真注释。
  `@param` / `@returns` **不受本条约束**：它们是形式锚点，作用是可判定地证明「这个参数被想过」，
  不承担解释业务的责任，解释仍写在描述正文里。
- **门禁只管可机械判定的那一半**：导出符号与公开成员有没有 JSDoc、tag 与签名是否一一对应，
  由 `make ts-export-jsdoc-check` 强制。「是否解释了复杂业务」「是否在复述显而易见的代码」
  不可机械判定，**没有门禁**，只能靠评审 —— 门禁过了不等于注释合格。
- **唯一红线是注释与代码不一致**：失真注释比没有注释更有害，评审时必查。
- 测试名称与第三方协议原文可保留英文；非显然的测试准备、故障注入和断言原因优先写中文注释。

## 门禁

严格选项与 ESLint 规则以本仓 `tooling/typescript/` 为机械事实来源。检查命令以各仓 `Makefile`
为准（见本仓 [`typescript-coding-conventions.md`](typescript-coding-conventions.md)「门禁」）。

`make verify*` 是只读检查。格式修复使用明确的写入命令；检查失败后必须修复真实类型或控制流，
不得用断言、disable 注释或降低配置掩盖问题。

测试工程可以放宽只读检查（例如断言数组长度后按下标取 fixture），放宽范围必须限于测试配置，
且不得被生产 package 继承。

## 跨仓一致性

本文件在两仓各存一份，内容必须逐字相同。它本身就在 `scripts/check-shared-files.mjs` 的逐字
比对清单里（该脚本同样两仓各一份，且把自身也列入清单）：

- 产品仓可直接比对 sibling SDK 工作区（CI 会把它按 `runtime.lock` 的 SHA checkout 成
  `../red-bean-qing-tuan`），因此「产品仓锁哪个 SDK 版本，就跟着那个版本的通用规范走」。
- SDK 仓是上游，sibling 工作区缺失时该检查跳过而非失败。

修改本文件的流程：先改 SDK 仓并提交 → 产品仓 bump `runtime.lock` 时会因为逐字比对失败而强制
同步。不要只改一边。
