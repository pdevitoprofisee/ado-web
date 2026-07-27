import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from '@tanstack/react-start'

import { LAUNCH_TOKEN_HEADER, LAUNCH_TOKEN_PATH, launchToken } from './lib/launch-token'
import { guardRequest } from './server/request-guard'

// Every request into this process runs this chain before any handler does.
//
// The origin check has to be named here even though Start ships it: when there
// is no start instance `createStartHandler` installs a default CSRF middleware,
// and when there is one it uses `requestMiddleware` verbatim. Omitting it would
// silently undo what T-002 established, with only a dev-time warning to say so.
//
// Its filter is widened past Start's default (`handlerType === 'serverFn'`) to
// cover the token bootstrap — the one path that answers with a secret, and so
// the one page request that must be same-origin only.
const originGuard = createCsrfMiddleware({
  filter: ({ handlerType, pathname }) =>
    handlerType === 'serverFn' || pathname === LAUNCH_TOKEN_PATH,
})

// `Host` and token, second so the bootstrap's origin is checked before a token
// is handed out. See src/server/request-guard.ts.
const localhostGuard = createMiddleware({ type: 'request' }).server(
  (ctx) => guardRequest(ctx) ?? ctx.next(),
)

/**
 * Client half of the token: runs on every server-function call, which is what
 * puts the header on the wire without touching a single call site.
 */
const sendLaunchToken = createMiddleware({ type: 'function' }).client(
  async ({ next }) => next({ headers: { [LAUNCH_TOKEN_HEADER]: await launchToken() } }),
)

export const startInstance = createStart(() => ({
  requestMiddleware: [originGuard, localhostGuard],
  functionMiddleware: [sendLaunchToken],
}))
