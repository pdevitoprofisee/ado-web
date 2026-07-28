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
import logo from '@/assets/prof-logo.png'

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
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-8">
      <header className="flex items-start gap-3">
        {/* Decorative: the heading is this screen's accessible name, and a mark
            announced as "Prof" would only be one more thing to skip past.
            Nudged down to sit on the heading's cap height, not its line box. */}
        {/* The mark is a raster, so it cannot follow the tokens: its navy dots
            measure 1.84:1 on the dark board and three quarters of it disappears.
            `brightness-0` then `invert` redraws the whole mark in white — chalk,
            which is what dark mode is here. It costs the teal dot its accent
            colour; a light plate behind the mark would keep it, but no `--paper-*`
            token stays light under `.dark` and the component layer holds no
            literal hex. */}
        <img src={logo} alt="" className="mt-1 size-9 shrink-0 dark:brightness-0 dark:invert" />
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold tracking-tight">
            {/* `inline-block` so the drawn underline measures the word rather
                than the column, and so its 8px of padding is real height —
                inline padding would let it run into the prose below. */}
            <span className="sketch-underline sketch-underline--teal inline-block">
              Connections
            </span>
          </h1>
          <p className="text-ink-500 text-sm">
            Both tokens are stored in the Windows credential manager and are only ever read on
            the server. Neither is sent to this page.
          </p>
        </div>
      </header>

      {/* One drawn panel, not one per service: these are two halves of a single
          setup step, and one outline with a rule down the middle says that
          where two cards would imply two unrelated jobs. */}
      <div className="sketch-box flex flex-col gap-5 p-5">
        <AzureDevOpsSection
          configured={status.data?.ado.configured ?? false}
          org={status.data?.ado.org ?? null}
        />
        {/* A drawn rule, not a `border-t`. It is 6px tall, which the panel's
            gap-5 already has room for. */}
        <hr className="sketch-rule" />
        <SonarCloudSection configured={status.data?.sonar.configured ?? false} />
      </div>

      {/* `self-start` so the focus ring wraps the word and not the column. */}
      <Link
        to="/"
        className="text-ink-500 hover:text-ink self-start text-sm underline underline-offset-4"
      >
        Back
      </Link>
    </main>
  )
}

// The pens live in `Alert`'s variants — wash, 1.5px stroke and hatched margin
// bar all arrive with `variant="destructive"`. Nothing coloured is stated here
// on purpose: an error on the setup screen should look like an error everywhere
// else, and a local tint would be a second opinion to keep in sync.
function Outcome({ result }: { result: ConnectionResult }) {
  if (result.ok) {
    return (
      <Alert>
        <CircleCheck />
        <AlertTitle>
          {result.account ? (
            // An account name is an identifier, so it is set in mono.
            <>
              Connected as <span className="font-mono">{result.account}</span>
            </>
          ) : (
            'Connected'
          )}
        </AlertTitle>
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

/**
 * The one screen where a field name is a *figure* label: this is a drawn page
 * with two fields on it, not the app's dense chrome, so the labels are set as
 * annotations. `ui/label.tsx` deliberately keeps its shared default in
 * sentence-case body ink — that is the right call for a form the eye skims, and
 * the wrong one here, so the annotation is asked for at this call site.
 *
 * Two classes restated rather than trusted: `Label`'s own `text-sm` and
 * `text-foreground` are *utilities*, and utilities outrank the component-layer
 * font shorthand `.annotation` sets. Secondary ink also keeps the field names
 * under the section headings, which are annotations in the strong ink.
 */
const FIELD_LABEL = 'annotation text-2xs text-ink-500'

function Section({
  title,
  configured,
  detail,
  onForget,
  children,
}: {
  title: string
  configured: boolean
  /** A node, not a string: the ADO half labels itself with an identifier. */
  detail: ReactNode
  onForget: () => void
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-4">
        {/* An annotation rather than a small sans heading — but in the strong
            ink, which is what keeps it reading as the section's name instead of
            as a label for the row beside it. */}
        <h2 className="annotation text-ink-900">{title}</h2>
        {configured ? (
          <span className="flex items-baseline gap-2">
            <span className="prof-badge prof-badge--teal">
              <span className="prof-badge__dot" aria-hidden />
              {detail}
            </span>
            <Button variant="ghost" size="sm" onPress={onForget}>
              Disconnect
            </Button>
          </span>
        ) : (
          // Amber is the waiting pen, and on first run that is exactly what
          // this is: nothing is wrong yet, nothing is done yet.
          <span className="prof-badge prof-badge--amber">
            <span className="prof-badge__dot" aria-hidden />
            Not configured
          </span>
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
      detail={<span className="font-mono">{org ?? ''}</span>}
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
          <Label className={FIELD_LABEL}>Organization</Label>
          <Input placeholder={org ?? 'Contoso'} autoComplete="off" />
        </TextField>

        <TextField className="flex flex-col gap-1.5" value={pat} onChange={setPat}>
          <Label className={FIELD_LABEL}>Personal access token</Label>
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
          <Label className={FIELD_LABEL}>Personal token</Label>
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
