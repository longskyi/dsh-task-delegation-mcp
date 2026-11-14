import { describe, expect, it } from 'vitest'
import { SessionInteractionBridge } from '../src/agents/bridge.js'
import { Logger } from '../src/logger.js'

interface Registered {
  event: string
  options?: { prepend?: boolean }
  listener: (...args: never[]) => unknown
}

function bridge(): SessionInteractionBridge {
  return new SessionInteractionBridge('s_1', 'remote', 1_000, 1_000, new Logger('error'))
}

function register(
  instance: SessionInteractionBridge,
  requireAgentMatch: boolean,
): Registered[] {
  const calls: Registered[] = []
  instance.register(
    {
      on: (event, listener, options) => {
        calls.push({ event, listener, ...(options === undefined ? {} : { options }) })
        return () => undefined
      },
    },
    requireAgentMatch,
  )
  return calls
}

describe('interaction bridge routing', () => {
  it('prepends root listeners and ignores other agents', async () => {
    const calls = register(bridge(), true)
    expect(calls.map((call) => call.event)).toEqual(['approval/request', 'user-questions/request'])
    expect(calls.every((call) => call.options?.prepend === true)).toBe(true)

    const approval = calls[0]?.listener as unknown as (
      request: unknown,
      next: () => Promise<string>,
    ) => Promise<string>
    let delegated = false
    const outcome = await approval(
      { agent: { id: 's_other' }, toolName: 'bash' },
      async () => {
        delegated = true
        return 'unavailable'
      },
    )
    expect(outcome).toBe('unavailable')
    expect(delegated).toBe(true)
  })

  it('does not prepend an already agent-scoped listener', () => {
    const calls = register(bridge(), false)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.options === undefined)).toBe(true)
  })
})
