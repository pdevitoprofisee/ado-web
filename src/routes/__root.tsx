import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools'
import { CommandProvider } from '../commands/command-provider'
import { Notifications } from '../components/notifications/notifications'
import { THEME_INIT_SCRIPT } from '../lib/theme'

import appCss from '../styles.css?url'

import type { QueryClient } from '@tanstack/react-query'

interface MyRouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  // SSR off for app routes. Inherited by every child route; the shell below is
  // prerendered once at build time and everything else renders on the client.
  ssr: false,
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'ado-web',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),
  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    // Paper is the default, and dark — chalk on a board — is `.dark` on this
    // element. `suppressHydrationWarning` is here because the class is put on
    // before React exists: this shell is prerendered without it, the script
    // below adds it, and the mismatch React would otherwise report is the
    // intended state of the document rather than a bug in it.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before the stylesheet is used and before the bundle exists, so a dark
            session never paints on paper first. `dangerouslySetInnerHTML` is the
            only way React inlines a script; what it carries is a build-time
            constant from `lib/theme.ts` with nothing of anyone's data in it,
            which is a different thing from the sanitised third-party HTML
            `rule-html.tsx` is careful never to hand to this attribute. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      {/* The grain overlay is fixed and covers the viewport, so it belongs
          once here rather than per-panel — one continuous sheet. */}
      <body className="paper-grain">
        {/* The app's one keydown listener, and the `?` sheet it renders. */}
        <CommandProvider>
          {children}
          {/* A sibling of the page rather than something inside it: the bell and
              its panel belong to the app, not to a route, and they need to be
              under the provider to claim `b` and Escape. Not wrapped — a div
              around `{children}` would put a block between `<body>` and every
              page's own layout. */}
          <Notifications />
        </CommandProvider>
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
