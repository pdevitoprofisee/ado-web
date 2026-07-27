import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

// localhost is not a security boundary: bind the loopback interface explicitly
// rather than inheriting a default that listens on every interface.
const HOST = '127.0.0.1'
const PORT = 3000

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: { host: HOST, port: PORT, strictPort: true },
  preview: { host: HOST, port: PORT, strictPort: true },
  plugins: [
    devtools(),
    nitro({ rollupConfig: { external: [/^@sentry\//] } }),
    tailwindcss(),
    // SSR is off for app routes (see the map): every route renders on the
    // client against a prerendered shell. We keep Start for its *server* half —
    // server functions, the only thing that talks to ADO or Sonar.
    tanstackStart({ spa: { enabled: true } }),
    viteReact(),
  ],
})

export default config
