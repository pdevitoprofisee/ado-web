import { createFileRoute } from '@tanstack/react-router'

// One pull request. Addressed by GUIDs rather than by the `Project/_git/Repo`
// names ADO puts in its own URLs, because those are what the inbox row already
// carries and what the server function validates by shape — a GUID cannot hold
// a traversal sequence, and three of these are interpolated into an ADO path.
//
// Stub: T-013 renders it, T-012 feeds it.

export const Route = createFileRoute('/pr/$projectId/$repositoryId/$prId')({
  component: PullRequestPage,
})

function PullRequestPage() {
  const { prId } = Route.useParams()

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-5 p-8">
      <h1 className="text-2xl font-semibold tracking-tight">!{prId}</h1>
    </main>
  )
}
