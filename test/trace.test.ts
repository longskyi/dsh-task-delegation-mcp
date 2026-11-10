import { describe, expect, it } from 'vitest'
import { formatTrace, type TraceEvent } from '../src/trace.js'

const events: TraceEvent[] = [
  { seq: 10, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'Fix the test' }] } },
  {
    seq: 11,
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'The fixture path is wrong.' },
          { type: 'text', text: 'I found the failing fixture.' },
        ],
      },
    },
  },
  { seq: 12, type: 'tool/call', data: { name: 'bash', arguments: '{"command":"npm test"}' } },
  { seq: 13, type: 'tool/result', data: { message: { isError: false, content: [{ type: 'text', text: 'PASS' }] } } },
  { seq: 14, type: 'approval/asked', data: { id: 'a_1', toolName: 'bash', reason: 'write outside workspace' } },
  { seq: 15, type: 'approval/decided', data: { id: 'a_1', outcome: 'allowed-once' } },
]

const base = {
  taskId: 't_1',
  limit: 50,
  include: ['messages', 'toolCalls', 'toolResults', 'interactions'] as const,
  maxBytes: 64 * 1024,
}

describe('formatTrace', () => {
  it('builds a readable transcript and excludes reasoning by default', () => {
    const page = formatTrace(events, { ...base, include: [...base.include] })
    expect(page.content).toContain('[10] user\nFix the test')
    expect(page.content).toContain('[11] assistant\nI found the failing fixture.')
    expect(page.content).toContain('[12] tool bash')
    expect(page.content).toContain('[13] tool result (error=false)')
    expect(page.content).toContain('[14] approval asked a_1')
    expect(page.content).toContain('[15] approval decided a_1: allowed-once')
    expect(page.content).not.toContain('fixture path is wrong')
    expect(page.state).toEqual({ taskId: 't_1', nextAfterSeq: 15, hasMore: false, truncated: false })
  })

  it('shows an ask_user_question call as an interaction', () => {
    const page = formatTrace(
      [{
        seq: 20,
        type: 'tool/call',
        data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Pick one' }] }) },
      }],
      { ...base, include: ['interactions'] },
    )
    expect(page.content).toContain('[20] question')
    expect(page.content).toContain('q1: Pick one')
    expect(page.content).not.toContain('tool ask_user_question')
  })

  it('includes reasoning only when asked', () => {
    const page = formatTrace(events, { ...base, include: [...base.include, 'reasoning'] })
    expect(page.content).toContain('[11] reasoning\nThe fixture path is wrong.')
  })

  it('paginates with afterSeq and limit', () => {
    const first = formatTrace(events, { ...base, limit: 2 })
    expect(first.state.nextAfterSeq).toBe(11)
    expect(first.state.hasMore).toBe(true)
    const second = formatTrace(events, { ...base, afterSeq: first.state.nextAfterSeq, limit: 50 })
    expect(second.content).not.toContain('[10]')
    expect(second.content).toContain('[12] tool bash')
    expect(second.state.hasMore).toBe(false)
  })

  it('marks per-event truncation and respects the exact byte budget', () => {
    const long = 'x'.repeat(20_000)
    for (const maxBytes of [256, 300, 1024]) {
      const page = formatTrace(
        [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } }],
        { ...base, limit: 10, maxBytes },
      )
      expect(page.content).toContain('[truncated]')
      expect(page.state.truncated).toBe(true)
      expect(Buffer.byteLength(page.content)).toBeLessThanOrEqual(maxBytes)
    }
  })

  it('never splits a surrogate pair when truncating', () => {
    const text = `${'a'.repeat(232)}😀`
    const page = formatTrace(
      [{ seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }],
      { ...base, limit: 10, maxBytes: 256 },
    )
    expect(Buffer.from(page.content, 'utf8').toString('utf8')).toBe(page.content)
  })

  it('respects afterSeq when nothing remains', () => {
    const page = formatTrace(events, { ...base, afterSeq: 15 })
    expect(page.content).toBe('No trace events in this range.')
    expect(page.state.hasMore).toBe(false)
    expect(page.state.nextAfterSeq).toBeUndefined()
  })
})
