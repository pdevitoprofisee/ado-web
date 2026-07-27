import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { TextField } from 'react-aria-components'
import { CircleAlert, CircleCheck } from 'lucide-react'

import {
  credentialStatus,
  forgetCredentialFn,
  saveAdoCredential,
  saveSonarCredential,
} from '@/server/credentials-fn'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import type { ReactNode } from 'react'
import type { ConnectionResult } from '@/server/connection-test'
import type { CredentialKind } from '@/server/credentials'

// Importing from `@/server/*` here is safe *because* every one of those imports
// is only reachable through a `createServerFn` handler, whose body the Start
// plugin strips from the client build. The T-003 resolution records the check
// that `@napi-rs/keyring` is absent from `.output/public`; if a future edit
// imports the store directly, that check is what fails.

export const Route = createFileRoute('/onboarding')({ component: Onboarding })

const STATUS_KEY = ['credential-status'] as const

function Onboarding() {
  const status = useQuery({ queryKey: STATUS_KEY, queryFn: () => credentialStatus() })

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="text-muted-foreground text-sm">
          Both tokens are stored in the Windows credential manager and are only ever read on
          the server. Neither is sent to this page.
        </p>
      </header>

      <AzureDevOpsSection
        configured={status.data?.ado.configured ?? false}
        org={status.data?.ado.org ?? null}
      />
      <SonarCloudSection configured={status.data?.sonar.configured ?? false} />

      <Link to="/" className="text-muted-foreground text-sm underline underline-offset-4">
        Back
      </Link>
    </main>
  )
}

function Outcome({ result }: { result: ConnectionResult }) {
  if (result.ok) {
    return (
      <Alert>
        <CircleCheck />
        <AlertTitle>{result.account ? `Connected as ${result.account}` : 'Connected'}</AlertTitle>
        {result.note ? <AlertDescription>{result.note}</AlertDescription> : null}
      </Alert>
    )
  }

  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>
        {result.reason === 'auth' ? 'Authentication failed' : 'Could not connect'}
      </AlertTitle>
      <AlertDescription>{result.message}</AlertDescription>
    </Alert>
  )
}

/** A thrown validator error — an empty field — rendered the same way as a rejection. */
function ThrownError({ error }: { error: Error }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>Could not connect</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  )
}

function useForget(kind: CredentialKind) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => forgetCredentialFn({ data: { kind } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: STATUS_KEY }),
  })
}

function Section({
  title,
  configured,
  detail,
  onForget,
  children,
}: {
  title: string
  configured: boolean
  detail: string
  onForget: () => void
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-base font-medium">{title}</h2>
        {configured ? (
          <span className="text-muted-foreground flex items-baseline gap-2 text-xs">
            {detail}
            <Button variant="ghost" size="sm" onPress={onForget}>
              Disconnect
            </Button>
          </span>
        ) : (
          <span className="text-muted-foreground text-xs">Not configured</span>
        )}
      </div>
      {children}
    </section>
  )
}

function AzureDevOpsSection({ configured, org }: { configured: boolean; org: string | null }) {
  const queryClient = useQueryClient()
  const forget = useForget('azure-devops')
  const [orgInput, setOrgInput] = useState('')
  const [pat, setPat] = useState('')

  const save = useMutation({
    mutationFn: (data: { org: string; pat: string }) => saveAdoCredential({ data }),
    onSuccess: (result) => {
      if (!result.ok) return
      // Clear the field on success so the token stops living in the DOM a
      // keystroke away from a screenshot.
      setPat('')
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY })
    },
  })

  return (
    <Section
      title="Azure DevOps"
      configured={configured}
      detail={org ?? ''}
      onForget={forget.mutate}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate({ org: orgInput || (org ?? ''), pat })
        }}
      >
        <TextField className="flex flex-col gap-1.5" value={orgInput} onChange={setOrgInput}>
          <Label>Organization</Label>
          <Input placeholder={org ?? 'Contoso'} autoComplete="off" />
        </TextField>

        <TextField className="flex flex-col gap-1.5" value={pat} onChange={setPat}>
          <Label>Personal access token</Label>
          {/* Needs Code (read), Build (read & execute) and Identity (read). */}
          <Input type="password" autoComplete="off" placeholder="••••••••" />
        </TextField>

        <Button type="submit" isDisabled={save.isPending} className="self-start">
          {save.isPending ? 'Testing…' : 'Test and save'}
        </Button>
      </form>

      {save.error ? <ThrownError error={save.error} /> : null}
      {save.data ? <Outcome result={save.data} /> : null}
    </Section>
  )
}

function SonarCloudSection({ configured }: { configured: boolean }) {
  const queryClient = useQueryClient()
  const forget = useForget('sonarcloud')
  const [token, setToken] = useState('')

  const save = useMutation({
    mutationFn: (data: { token: string }) => saveSonarCredential({ data }),
    onSuccess: (result) => {
      if (!result.ok) return
      setToken('')
      void queryClient.invalidateQueries({ queryKey: STATUS_KEY })
    },
  })

  return (
    <Section
      title="SonarCloud"
      configured={configured}
      detail="Token stored"
      onForget={forget.mutate}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate({ token })
        }}
      >
        <TextField className="flex flex-col gap-1.5" value={token} onChange={setToken}>
          <Label>Personal token</Label>
          {/* Only a *personal* token can read issues; analysis and scoped
              organization tokens validate but return nothing useful. */}
          <Input type="password" autoComplete="off" placeholder="••••••••" />
        </TextField>

        <Button type="submit" isDisabled={save.isPending} className="self-start">
          {save.isPending ? 'Testing…' : 'Test and save'}
        </Button>
      </form>

      {save.error ? <ThrownError error={save.error} /> : null}
      {save.data ? <Outcome result={save.data} /> : null}
    </Section>
  )
}
