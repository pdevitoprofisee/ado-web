import { Link } from '@tanstack/react-router'
import { Layers01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'

import type { ReactNode } from 'react'

import type { PullRequestStack } from '@/lib/stack'
import type { PullRequestRef } from '@/server/pull-request'

const LINK = 'text-primary underline decoration-[1.5px] underline-offset-[3px]'

/** Another pull request in the same repository, as an in-app link. */
function PullRequestLink({
  prRef,
  id,
  className,
  children,
}: {
  prRef: PullRequestRef
  id: number
  className?: string
  children: ReactNode
}) {
  return (
    <Link
      to="/pr/$projectId/$repositoryId/$prId"
      params={{ projectId: prRef.projectId, repositoryId: prRef.repositoryId, prId: String(id) }}
      className={className}
    >
      {children}
    </Link>
  )
}

/** The header's note: which pull request this one is stacked on. */
export function StackMark({ stack, prRef }: { stack: PullRequestStack; prRef: PullRequestRef }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <HugeiconsIcon
        icon={Layers01Icon}
        size={14}
        aria-hidden
        className="text-muted-foreground self-center"
      />
      {stack.parent ? (
        <>
          on
          <PullRequestLink prRef={prRef} id={stack.parent.id} className={`${LINK} font-mono`}>
            !{stack.parent.id}
          </PullRequestLink>
        </>
      ) : (
        'base of stack'
      )}
    </span>
  )
}

/** The whole stack, top first, with the trunk branch it lands on at the bottom. */
export function StackTree({ stack, prRef }: { stack: PullRequestStack; prRef: PullRequestRef }) {
  return (
    <ol className="flex flex-col gap-1 text-sm">
      {stack.members.map((member) => (
        <li
          key={member.id}
          className="flex min-w-0 items-baseline gap-2"
          style={{ paddingLeft: `${member.depth * 1.25}rem` }}
        >
          {member.id === prRef.id ? (
            <span aria-current="page" className="flex min-w-0 items-baseline gap-2 font-medium">
              <span className="font-mono text-xs">!{member.id}</span>
              <span className="truncate">{member.title}</span>
              <span className="text-muted-foreground text-xs font-normal">this pull request</span>
            </span>
          ) : (
            <PullRequestLink
              prRef={prRef}
              id={member.id}
              className="flex min-w-0 items-baseline gap-2"
            >
              <span className="text-muted-foreground font-mono text-xs">!{member.id}</span>
              <span className={`${LINK} truncate`}>{member.title}</span>
            </PullRequestLink>
          )}
          {member.isDraft ? (
            <span className="prof-badge prof-badge--amber tracking-label px-1.5 py-0.5 text-2xs leading-none uppercase">
              draft
            </span>
          ) : null}
        </li>
      ))}
      <li className="text-muted-foreground font-mono text-xs">{stack.trunk}</li>
    </ol>
  )
}
