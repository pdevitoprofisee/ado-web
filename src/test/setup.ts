import '@testing-library/jest-dom/vitest'

import { beforeEach } from 'vitest'

// Queries read saved state at start, so a value one test saves must not seed the next.
beforeEach(() => {
  globalThis.localStorage?.clear()
})
