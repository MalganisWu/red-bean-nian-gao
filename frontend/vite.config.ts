import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rolldownOptions: {
      output: {
        // 手动分包：把重型依赖拆出主包，避免单 chunk >500kB，并利于长缓存
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // 书版消息渲染链：react-markdown + remark/rehype + 代码高亮（lowlight/highlight.js）
          if (
            /(\/|node_modules\/)(react-markdown|remark|rehype|unified|mdast|hast|unist|micromark|lowlight|highlight\.js|property-information|comma-separated-tokens|space-separated-tokens|character-entities|trim-lines|devlop|decode-named-character-reference|escape-string-regexp|vfile|estree|decamelize)/.test(
              id
            )
          ) {
            return 'markdown'
          }
          // React 框架 + 路由（react 也在 /node_modules/ 下，先于 markdown 匹配已把 react-markdown 排除）
          if (/(\/|node_modules\/)(react|react-dom|react-router|scheduler|react-is)/.test(id)) {
            return 'react-vendor'
          }
          // 其余第三方（UI/图标/状态/日期）单独成包，稳定各自体积
          if (
            /(\/|node_modules\/)(@base-ui|lucide-react|sonner|zustand|date-fns|class-variance-authority|tailwind-merge|clsx)/.test(
              id
            )
          ) {
            return 'vendor'
          }
          return undefined
        },
      },
    },
  },
  resolve: {
    // design-system 通过源码 alias 进入前端；显式去重可避免 Vitest/开发态从
    // 两个 node_modules 各加载一份 React，触发 Invalid hook call。
    dedupe: ['react', 'react-dom', '@base-ui/react'],
    alias: [
      // 强制所有模块使用前端唯一的 React 实例，避免 design-system 的 node_modules 引入第二份 React
      { find: 'react', replacement: path.resolve(__dirname, 'node_modules/react') },
      { find: 'react-dom', replacement: path.resolve(__dirname, 'node_modules/react-dom') },
      // design-system 源码中的图标依赖也必须从前端依赖树解析，否则其预构建包会闭包第二份 React。
      { find: 'lucide-react', replacement: path.resolve(__dirname, 'node_modules/lucide-react') },
      {
        find: '@base-ui/react',
        replacement: path.resolve(__dirname, 'node_modules/@base-ui/react'),
      },
      // design-system 是组件唯一源（必须放在 @ 之前，优先匹配）
      {
        find: '@/components/retroui',
        replacement: path.resolve(__dirname, '../design-system/src/components'),
      },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/health': 'http://localhost:8080',
      '/readyz': 'http://localhost:8080',
      '/version': 'http://localhost:8080',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
  },
})
