import { defineConfig } from 'vitest/config'
import viteReact from '@vitejs/plugin-react'

// Deliberately separate from vite.config.ts: the Start and Nitro plugins own a
// build pipeline (route generation, server-function RPC stubs, a Nitro server)
// that has nothing to offer a unit test run.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  plugins: [viteReact()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
