import { Link, createFileRoute } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useQuery } from '@tanstack/react-query'

import { credentialStatus } from '@/server/credentials-fn'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'

// The scaffold's proof-of-life for the half of the app that matters: this body
// is replaced by an RPC stub in the client bundle, so `process` is only ever
// read on the server. Everything that touches a PAT, ADO, or Sonar lives here.
const getServerInfo = createServerFn({ method: 'GET' }).handler(async () => ({
  node: process.version,
  pid: process.pid,
}))

export const Route = createFileRoute('/')({ component: Home })

function Home() {
  const server = useQuery({
    queryKey: ['server-info'],
    queryFn: () => getServerInfo(),
  })
  const credentials = useQuery({
    queryKey: ['credential-status'],
    queryFn: () => credentialStatus(),
  })

  const connected = [
    credentials.data?.ado.configured ? `Azure DevOps (${credentials.data.ado.org})` : null,
    credentials.data?.sonar.configured ? 'SonarCloud' : null,
  ].filter(Boolean)

  return (
    <main className="mx-auto flex max-w-xl flex-col items-start gap-4 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">ado-web</h1>
      <p className="text-muted-foreground text-sm">
        Scaffold only. The inbox lands in T-006. Press{' '}
        <Kbd>?</Kbd> for keyboard shortcuts.
      </p>

      <p className="text-sm">
        Server function says:{' '}
        <code className="bg-muted rounded px-1.5 py-0.5 text-xs">
          {server.isPending
            ? 'asking…'
            : server.isError
              ? `failed: ${server.error.message}`
              : `node ${server.data.node}, pid ${server.data.pid}`}
        </code>
      </p>

      <p className="text-sm">
        Connections:{' '}
        {credentials.isPending
          ? 'checking…'
          : connected.length > 0
            ? connected.join(', ')
            : 'none yet'}
        {' — '}
        <Link to="/onboarding" className="underline underline-offset-4">
          manage
        </Link>
      </p>

      <Button onPress={() => server.refetch()} isDisabled={server.isFetching}>
        Ask the server again
      </Button>
    </main>
  )
}
