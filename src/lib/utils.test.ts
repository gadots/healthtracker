import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('joins class names and drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, null, 'c')).toBe('a c')
  })

  it('lets a later Tailwind class win over a conflicting earlier one', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
    expect(cn('text-sm text-muted-foreground', 'text-foreground')).toBe('text-sm text-foreground')
  })

  it('returns an empty string with no usable input', () => {
    expect(cn()).toBe('')
    expect(cn(false, undefined)).toBe('')
  })
})
