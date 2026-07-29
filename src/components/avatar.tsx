import { useState } from 'react'

import { initials } from '@/lib/people'
import { cn } from '@/lib/utils'

import type { AvatarUrlForm } from '@/lib/identity-contract'
import type { ReactNode } from 'react'

// A face, or a monogram when there is not one.
//
// **The whole of this component is one question: is this a URL the browser can
// actually fetch?** T-030 measured that `imageUrl` is not one URL form, and which
// form you get depends entirely on which object you read it off:
//
//   - a comment `author.imageUrl` → `MemberAvatars`, 42 of 42
//   - a reviewer `imageUrl` → `identityImage`, 30 of 30
//   - a pull request's `createdBy.imageUrl` → `identityImage`, 99 of 99
//
// `_apis/GraphProfile/MemberAvatars/{descriptor}` answers **200 with the PNG and
// no auth header at all** — no cookie, no PAT — so it goes straight into an
// `<img src>` and no credential goes anywhere near the browser. That is what
// removed the image-proxying endpoint T-036 was written expecting.
// `_api/_common/identityImage?id={guid}` answers **302 to the sign-in page**
// without a credential, which in an `<img>` is a broken glyph. So `imageUrl`
// rendered on trust works on every comment and breaks on every reviewer and
// every author — the field name tells you nothing, only the URL does.
//
// Which is why {@link avatarUrlForm} is an **allowlist**. The one form measured
// to answer anonymously is rendered; the redirecting form, the third form
// (`graph/Subjects/{descriptor}/avatars`, which answers JSON with a base64 value
// rather than image bytes), and anything unrecognised all fall to the monogram. A
// URL nobody measured is not a URL to put in the DOM.

/** The one path that needs no credential, and `_apis` is not `_api`. */
const MEMBER_AVATAR = /\/_apis\/graphprofile\/memberavatars\/[^/]+$/

/** The one that needs one. Distinguished from "unrecognised" so a test can say which. */
const IDENTITY_IMAGE = /\/_api\/_common\/identityimage$/

/**
 * Which of ADO's two avatar URL forms `href` is, or `null` for neither.
 *
 * Matched on the **parsed pathname**, not on the string: a substring test would
 * accept `identityImage?redirect=/_apis/GraphProfile/MemberAvatars/x` and hand
 * the browser the credentialed form anyway. Lower-cased because only the path is
 * compared — the descriptor is base64url and case-sensitive, so the caller gets
 * the original `href` back to load, never this one.
 */
export function avatarUrlForm(href: string): AvatarUrlForm | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null

  const path = url.pathname.toLowerCase()
  if (MEMBER_AVATAR.test(path)) return 'member-avatar'
  if (IDENTITY_IMAGE.test(path)) return 'identity-image'

  return null
}

export function Avatar({
  href,
  name,
  className,
  fallback,
}: {
  /** Either of ADO's forms, or `null`. Only the credential-free one is loaded. */
  href: string | null
  /** The monogram comes from here, so this is the display name and not an alt text. */
  name: string
  /** Size lives at the call site, the way every other `.prof-avatar` does. */
  className?: string
  /**
   * Drawn instead of the monogram when there is no image — the group glyph the
   * reviewer list wants, because `[Products]\Contributors` has no initials worth
   * reading and `initials()` deliberately refuses to invent any.
   */
  fallback?: ReactNode
}) {
  // The href that failed rather than a boolean, because these are recycled: the
  // diff is virtualized and React reconciles rows by position, so a `true` here
  // would follow the element onto the next person and blank out their face too.
  const [failed, setFailed] = useState<string | null>(null)
  const src = href !== null && href !== failed && avatarUrlForm(href) === 'member-avatar' ? href : null

  return (
    // The monogram is always in the box and the image sits **on top of it**, which
    // is what makes a slow avatar and a missing one look the same: there is never
    // an empty circle to fill in. `relative` is the only thing added here —
    // `.prof-avatar` already has `overflow: hidden`, the blob radius, and
    // `img { width: 100%; height: 100%; object-fit: cover }`, so nothing about
    // this needs CSS and nothing needs a `rounded-*` utility (which, on a
    // multi-value sketch radius, would silently drop).
    //
    // `aria-hidden` and `alt=""`, both: every one of the three call sites draws
    // the person's name as text immediately beside this. "Paul DeVito Paul
    // DeVito" is worse than no avatar at all.
    <span className={cn('prof-avatar relative', className)} aria-hidden>
      {fallback ?? initials(name)}
      {src === null ? null : (
        <img
          src={src}
          alt=""
          // Sixty comments is sixty `<img>` elements, and the answer to the
          // request storm is that they are not sixty requests: the same person
          // is the same URL string, which the browser coalesces, and `lazy`
          // means the ones below the fold are never asked for at all. No cache
          // is built on top of that. One would have to be a server function
          // holding bytes, which is the credential path this whole feature just
          // removed — for a median 522-byte PNG on an endpoint that reported
          // `x-ratelimit-cost: 0`. The measured wrinkle is that `MemberAvatars`
          // answered anonymously sends `no-cache, no-store` rather than the
          // `max-age=172800` it sends to a credentialed caller, so reuse across
          // a reload is not promised — within a page it is, and that is where
          // sixty comments live.
          loading="lazy"
          className="absolute inset-0"
          onError={() => setFailed(src)}
        />
      )}
    </span>
  )
}
