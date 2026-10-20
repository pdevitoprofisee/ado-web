// The repo's own Vite config with two changes for a verification instance.
// cacheDir: the default `node_modules/.vite` is shared with the user's `pnpm dev`,
// and a second server re-optimizes into it under the running one.
// port: vite.config.ts pins 7331 with strictPort, which the user's server owns.
import { mergeConfig } from 'vite'

import base from '../../../../vite.config.ts'

const port = Number(process.env.ADO_WEB_VERIFY_PORT)
const cacheDir = process.env.ADO_WEB_VERIFY_CACHE

if (!port || !cacheDir) {
  throw new Error('Start this config through launch.mjs, which sets ADO_WEB_VERIFY_PORT and ADO_WEB_VERIFY_CACHE.')
}

export default mergeConfig(base, {
  cacheDir,
  server: { port, strictPort: true },
})
