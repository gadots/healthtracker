import { describe, expect, it } from 'vitest'
import { HealthAssistant } from './HealthAssistant'
import { HealthAssistant as HealthAssistantStub } from './HealthAssistant.web-stub'

/**
 * Keeps the web stub's signature tied to the real assistant's.
 *
 * `vite.config.ts` swaps the two only in the bundler (`--mode web`), while
 * `tsc` resolves the real module through the `@/*` path alias in both modes.
 * The stub's props are therefore never compared against the call site in
 * `App.tsx`, so it can fall behind in total silence — which is exactly what
 * happened when the assistant gained `archiveDays`. Nothing in typecheck, the
 * tests, or either build reported it.
 *
 * The assertions below are compile-time: the value of this file is that
 * `npm run check` stops passing when the signatures diverge. The runtime
 * expectation is only here so the file reads as a test rather than a fixture.
 */

type RealProps = Parameters<typeof HealthAssistant>[0]
type StubProps = Parameters<typeof HealthAssistantStub>[0]

describe('HealthAssistant web stub', () => {
  it('accepts everything App.tsx passes to the real assistant', () => {
    // Fails to compile if the real component gains a prop the stub lacks.
    const realToStub = (props: RealProps): StubProps => props
    // And the other way, so the stub cannot demand props that do not exist.
    const stubToReal = (props: StubProps): RealProps => props

    expect(realToStub).toBeTypeOf('function')
    expect(stubToReal).toBeTypeOf('function')
  })

  it('renders nothing, because a browser cannot spawn the assistant CLIs', () => {
    expect(HealthAssistantStub({
      open: true,
      data: {} as StubProps['data'],
      page: 'today',
      archiveDays: [],
      onOpenChange: () => {},
      onNavigate: () => {},
    })).toBeNull()
  })
})
