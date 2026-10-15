// 前端与 Design System 共用的 JSX 无障碍静态规则（本仓特有，不在跨仓共享件清单里）。
//
// 为什么不用 eslint-plugin-jsx-a11y：它的最新版 6.10.2 的 peer 范围是 `^3 … ^9`，**不支持本仓
// 使用的 ESLint 10**，且没有 v7 或测试版。硬装要放宽 peer，而这些规则内部还在用 ESLint 10 可能
// 已移除的旧 API。这条规则用 no-restricted-syntax 的 esquery 选择器表达：零依赖、不挑版本。
//
// 覆盖的缺陷：`<div role="button" tabIndex={0} onClick={...}>` —— 可聚焦、鼠标点得动，键盘按
// Enter/Space 却什么都不发生。`role` 只声明语义，不附带行为；`tabIndex` 只让它能获得焦点。
// 真实案例见 `design-system/src/components/TrajectoryLedger.tsx` 的三处摘要行。

/** 原生就带键盘激活能力的元素，不需要这条规则。 */
const NATIVE_ACTIVATABLE = ['button', 'a', 'input', 'select', 'textarea', 'summary']

/**
 * 原生（小写）元素上有 `onClick`、却没有 `onKeyDown` / `onKeyUp` / `onKeyPress` 时报错。
 *
 * 只匹配原生元素，不匹配 `Xxx` 组件 —— 组件的键盘处理可能在其内部实现，静态看不到。
 */
export const keyboardActivationRule = {
  selector:
    'JSXOpeningElement[name.name=/^[a-z]/]' +
    NATIVE_ACTIVATABLE.map((name) => `:not([name.name="${name}"])`).join('') +
    ':has(JSXAttribute[name.name="onClick"])' +
    ':not(:has(JSXAttribute[name.name=/^onKey/]))',
  message:
    '可交互元素缺少键盘通路：优先改成原生语义控件（<button>）；确因结构限制保留自定义元素时，补 Enter/Space 的 onKeyDown 处理。',
}
