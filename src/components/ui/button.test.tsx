import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { Button } from './button'

// A smoke test for the aria base specifically: React Aria's Button takes
// `onPress`, not `onClick`. If someone ever re-inits shadcn on a different base
// this test is the thing that notices.
describe('Button', () => {
  it('fires onPress and respects isDisabled', async () => {
    const onPress = vi.fn()
    const user = userEvent.setup()

    const { rerender } = render(<Button onPress={onPress}>Go</Button>)
    await user.click(screen.getByRole('button', { name: 'Go' }))
    expect(onPress).toHaveBeenCalledOnce()

    rerender(
      <Button onPress={onPress} isDisabled>
        Go
      </Button>,
    )
    await user.click(screen.getByRole('button', { name: 'Go' }))
    expect(onPress).toHaveBeenCalledOnce()
  })
})
