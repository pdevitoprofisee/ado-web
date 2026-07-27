import { defineConfig } from 'vite'
import { devtools } from '@tanstack/devtools-vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { nitro } from 'nitro/vite'

// localhost is not a security boundary: bind the loopback interface explicitly
// rather than inheriting a default that listens on every interface.
// Deliberately not 3000: that port is contended by every other dev server on the
// machine, and `strictPort` turns a collision into a failed boot rather than a
// silent move to 3001. Keep in sync with scripts/start.mjs, which binds the
// production build.
const HOST = '127.0.0.1'
const PORT = 7331

const KEYRING = '@napi-rs/keyring'

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: { host: HOST, port: PORT, strictPort: true },
  preview: { host: HOST, port: PORT, strictPort: true },
  // `@napi-rs/keyring` loads a prebuilt `.node` binary through a require() the
  // bundler tries to read as source ("stream did not contain valid UTF-8"). A
  // native addon cannot be bundled at all, so leave the import standing and let
  // Node resolve it at runtime — safe here precisely because the server half
  // never ships anywhere: `.output/` runs from this checkout, next to the
  // node_modules that holds the binary.
  //
  // Three settings because three separate passes reach for it: `optimizeDeps`
  // is the dev prebundler, `resolve.external` is dev SSR resolution, and
  // `rollupOptions.external` is the production build. Missing any one of them
  // fails only on the command that uses it, so change all three together.
  optimizeDeps: { exclude: [KEYRING] },
  environments: {
    nitro: {
      optimizeDeps: { exclude: [KEYRING] },
      resolve: { external: [KEYRING] },
      build: { rollupOptions: { external: [KEYRING] } },
    },
  },
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
