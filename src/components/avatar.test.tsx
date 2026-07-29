import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Avatar, avatarUrlForm } from './avatar'

// One question, asked twice: is this a URL the browser can fetch, and what is
// drawn when it is not. T-030 measured that `imageUrl` is two different URL forms
// depending on which object you read it off — `MemberAvatars` on 42 of 42 comment
// authors, `identityImage` on 30 of 30 reviewers and 99 of 99 pull request authors
// — and only one of the two answers without a credential.

const MEMBER = 'https://dev.azure.com/profisee/_apis/GraphProfile/MemberAvatars/aad.OWY0NTIwYTMtMzc'
const IDENTITY = 'https://dev.azure.com/profisee/_api/_common/identityImage?id=abc'

describe('avatarUrlForm', () => {
  it('names each of the two forms ADO actually sends', () => {
    expect(avatarUrlForm(MEMBER)).toBe('member-avatar')
    expect(avatarUrlForm(IDENTITY)).toBe('identity-image')
  })

  it('reads the path and not the string, so a query cannot smuggle one form into the other', () => {
    // A substring test would call this the credential-free form and hand the
    // browser a redirect to a sign-in page.
    expect(
      avatarUrlForm(
        'https://dev.azure.com/profisee/_api/_common/identityImage?redirect=/_apis/GraphProfile/MemberAvatars/aad.x',
      ),
    ).toBe('identity-image')
  })

  it('does not recognise the third form, which answers JSON rather than image bytes', () => {
    // `graph/Subjects/{descriptor}/avatars` returns a base64 `value` in a JSON
    // envelope. An `<img src>` pointed at it draws nothing.
    expect(
      avatarUrlForm('https://vssps.dev.azure.com/profisee/_apis/graph/Subjects/aad.x/avatars'),
    ).toBeNull()
  })

  it('refuses anything that is not an https URL at all', () => {
    expect(avatarUrlForm('/_apis/GraphProfile/MemberAvatars/aad.x')).toBeNull()
    expect(avatarUrlForm('http://dev.azure.com/profisee/_apis/GraphProfile/MemberAvatars/aad.x')).toBeNull()
    expect(avatarUrlForm('')).toBeNull()
  })
})

describe('Avatar', () => {
  it('loads the credential-free form as it was given, casing and all', () => {
    // The descriptor is base64url and case-sensitive, so the href that goes into
    // the DOM must be the original and never the lower-cased one the path match
    // compared.
    const { container } = render(<Avatar href={MEMBER} name="Ada Lovelace" />)

    expect(container.querySelector('img')).toHaveAttribute('src', MEMBER)
    // Sized by the caller, so the box is there before the image is.
    expect(container.querySelector('.prof-avatar')).toHaveTextContent('AL')
  })

  it('draws the monogram alone when the URL needs a credential', () => {
    const { container } = render(<Avatar href={IDENTITY} name="Ada Lovelace" />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.prof-avatar')).toHaveTextContent('AL')
  })

  it('draws the monogram alone when there is no URL', () => {
    const { container } = render(<Avatar href={null} name="Ada Lovelace" />)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.prof-avatar')).toHaveTextContent('AL')
  })

  it('falls back to the monogram when the image fails to load', () => {
    // A 404 or a revoked descriptor is a broken-image glyph otherwise. jsdom never
    // fetches anything, so the event is the only way to reach this.
    const { container } = render(<Avatar href={MEMBER} name="Ada Lovelace" />)
    const image = container.querySelector('img')
    expect(image).not.toBeNull()

    fireEvent.error(image as HTMLImageElement)

    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('.prof-avatar')).toHaveTextContent('AL')
  })

  it('draws the fallback the caller gave instead of a monogram', () => {
    // What the reviewer list wants for a group: `[Products]\Contributors` has no
    // initials worth reading and `initials()` refuses to invent any.
    const { container } = render(
      <Avatar href={null} name="[Products]\Contributors" fallback={<span>group</span>} />,
    )

    expect(container.querySelector('.prof-avatar')).toHaveTextContent('group')
  })

  it('is hidden from a screen reader, because the name is written beside it', () => {
    const { container } = render(<Avatar href={MEMBER} name="Ada Lovelace" />)

    expect(container.querySelector('.prof-avatar')).toHaveAttribute('aria-hidden', 'true')
    expect(container.querySelector('img')).toHaveAttribute('alt', '')
  })
})
