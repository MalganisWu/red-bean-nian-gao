import '@testing-library/jest-dom/vitest'

// Node 25 暴露了一个未配置文件路径的实验性 localStorage 全局对象；它会遮蔽
// jsdom 实现。缺少标准方法时安装最小的内存实现。
if (typeof globalThis.localStorage?.getItem !== 'function') {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size
      },
    } satisfies Storage,
  })
}

// jsdom 无 matchMedia（ChatMessages 的 prefers-reduced-motion 判断等依赖它）：
// 默认按「无减动效偏好」处理，单测可用 vi.stubGlobal 覆盖
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}
