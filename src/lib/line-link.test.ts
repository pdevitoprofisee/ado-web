import { describe, expect, it } from 'vitest'

import { linePermalink, readLineTarget } from './line-link'

// T-055. What a permalink says and what comes back out of one, which is the whole
// of the round trip: the string is written on one machine and read on another,
// and the two halves are the only place a path can be lost.

const PAGE = 'https://reviews.local/pr/aaaa/bbbb/24698'

describe('linePermalink', () => {
  it('carries a path through the fragment intact', () => {
    expect(linePermalink(PAGE, '/src/log.ts', 214)).toBe(
      `${PAGE}#path=%2Fsrc%2Flog.ts&line=214`,
    )
  })

  it('escapes the characters a path is allowed to contain', () => {
    // A space becomes `+` and a `+` becomes `%2B` under form encoding, which is
    // only correct because `readLineTarget` decodes by the same rule. Read any
    // other way — `decodeURIComponent` on the raw fragment, say — the space comes
    // back as a plus and the file is not found.
    const link = linePermalink(PAGE, '/src/a b/c+d.ts', 1)

    expect(link).toContain('%2Fsrc%2Fa+b%2Fc%2Bd.ts')
    expect(readLineTarget(new URL(link).hash)?.path).toBe('/src/a b/c+d.ts')
  })

  it('keeps the query, because on the branch compare it is which diff this is', () => {
    // `?target=` pins the base. A link that dropped it would open the same line
    // number in a different diff.
    expect(linePermalink(`${PAGE}?target=release%2F9.1`, '/src/log.ts', 3)).toBe(
      `${PAGE}?target=release%2F9.1#path=%2Fsrc%2Flog.ts&line=3`,
    )
  })

  it('replaces a fragment that is already there rather than appending to it', () => {
    // Copying a second line from a page opened on somebody else's permalink is the
    // ordinary case, not an edge one.
    expect(linePermalink(`${PAGE}#path=%2Fsrc%2Fold.ts&line=9`, '/src/log.ts', 3)).toBe(
      `${PAGE}#path=%2Fsrc%2Flog.ts&line=3`,
    )
  })
})

describe('readLineTarget', () => {
  it('reads back what was written', () => {
    expect(readLineTarget('#path=%2Fsrc%2Flog.ts&line=214')).toEqual({
      path: '/src/log.ts',
      line: 214,
    })
  })

  it('does not mind whether the hash still has its #', () => {
    expect(readLineTarget('path=%2Fsrc%2Flog.ts&line=1')).toEqual({ path: '/src/log.ts', line: 1 })
  })

  it('answers nothing for a URL that is not asking for a line', () => {
    expect(readLineTarget('')).toBeNull()
    expect(readLineTarget('#')).toBeNull()
    expect(readLineTarget('#some-other-anchor')).toBeNull()
  })

  it('answers nothing rather than throwing on a link that arrived damaged', () => {
    // Chat clients truncate, and a stranger typed this. Half a link should open
    // the page it names and stop there.
    expect(readLineTarget('#path=%2Fsrc%2Flog.ts')).toBeNull()
    expect(readLineTarget('#line=214')).toBeNull()
    expect(readLineTarget('#path=&line=214')).toBeNull()
    expect(readLineTarget('#path=%2Fsrc%2Flog.ts&line=nine')).toBeNull()
  })

  it('refuses a line number no file has', () => {
    // Zero and below are not lines, and a fraction is not one either. Each would
    // otherwise be handed to the panel, which would hunt for a row and say the
    // line is not in the diff — true, and a worse answer than saying nothing.
    expect(readLineTarget('#path=%2Fsrc%2Flog.ts&line=0')).toBeNull()
    expect(readLineTarget('#path=%2Fsrc%2Flog.ts&line=-4')).toBeNull()
    expect(readLineTarget('#path=%2Fsrc%2Flog.ts&line=2.5')).toBeNull()
  })
})
