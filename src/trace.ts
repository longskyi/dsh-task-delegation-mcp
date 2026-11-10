import type { TraceInclude, TraceState } from './types.js'

/** Structural slice of a DSH SessionEvent; the adapter never exposes raw JSON. */
export interface TraceEvent {
  seq: number
  type: string
  data?: unknown
}

export interface TraceFormatOptions {
  taskId: string
  afterSeq?: number
  limit: number
  include: readonly TraceInclude[]
  maxBytes: number
}

export interface TracePage {
  content: string
  state: TraceState
}

const DEFAULT_EVENT_BYTES = 8 * 1024

/** Build the readable trace page. Pure; the adapter supplies events. */
export function formatTrace(events: readonly TraceEvent[], options: TraceFormatOptions): TracePage {
  const include = new Set(options.include)
  const selected = events
    .filter((event) => event.seq > (options.afterSeq ?? -1))
    .sort((a, b) => a.seq - b.seq)
    .flatMap((event) => fragmentsOf(event, include))

  const maxBytes = Math.max(1, options.maxBytes)
  const parts: string[] = []
  let bytes = 0
  let truncated = false
  let included = 0
  let nextAfterSeq: number | undefined

  for (const [index, fragment] of selected.entries()) {
    if (included >= options.limit) break
    const separator = parts.length === 0 ? '' : '\n'
    const remaining = maxBytes - bytes - Buffer.byteLength(separator)
    if (remaining <= 0) {
      truncated = true
      break
    }
    const eventCap = Math.min(DEFAULT_EVENT_BYTES, remaining)
    const bounded = truncateUtf8(fragment.text, eventCap)
    if (bounded.truncated) truncated = true
    if (bounded.text === '' && fragment.text !== '') {
      truncated = true
      break
    }
    const piece = `${separator}${bounded.text}`
    parts.push(piece)
    bytes += Buffer.byteLength(piece)
    included += 1
    nextAfterSeq = fragment.seq
    if (index === selected.length - 1) break
    if (bytes >= maxBytes) {
      truncated = true
      break
    }
  }

  const hasMore = selected.length > included
  let content = parts.join('')
  if (content === '') content = 'No trace events in this range.'
  else if (!content.endsWith('\n') && Buffer.byteLength(content) < maxBytes) content = `${content}\n`
  return {
    content,
    state: {
      taskId: options.taskId,
      ...(nextAfterSeq === undefined ? {} : { nextAfterSeq }),
      hasMore,
      truncated,
    },
  }
}

interface Fragment {
  seq: number
  text: string
}

function fragmentsOf(event: TraceEvent, include: ReadonlySet<TraceInclude>): Fragment[] {
  const data = asRecord(event.data)
  switch (event.type) {
    case 'user/message': {
      if (!include.has('messages')) return []
      const text = contentText(data?.content)
      return text === '' ? [] : [{ seq: event.seq, text: `[${event.seq}] user\n${text}\n` }]
    }
    case 'assistant/message': {
      const message = asRecord(data?.message)
      const sections: string[] = []
      if (include.has('messages')) {
        const text = contentText(message?.content)
        if (text !== '') sections.push(`[${event.seq}] assistant\n${text}`)
      }
      if (include.has('reasoning')) {
        const reasoning = contentText(message?.content, 'reasoning')
        if (reasoning !== '') sections.push(`[${event.seq}] reasoning\n${reasoning}`)
      }
      return sections.length === 0 ? [] : [{ seq: event.seq, text: `${sections.join('\n\n')}\n` }]
    }
    case 'tool/call': {
      const name = stringOf(data?.name) ?? '?'
      const args = stringOf(data?.arguments) ?? ''
      if (name === 'ask_user_question' && include.has('interactions')) {
        return [{ seq: event.seq, text: `[${event.seq}] question\n${questionText(args)}\n` }]
      }
      if (include.has('toolCalls')) {
        return [{ seq: event.seq, text: `[${event.seq}] tool ${name}\nargs: ${args}\n` }]
      }
      return []
    }
    case 'tool/result': {
      if (!include.has('toolResults')) return []
      const message = asRecord(data?.message)
      const text = contentText(message?.content)
      const failed = message?.isError === true || data?.error !== undefined
      return [{
        seq: event.seq,
        text: `[${event.seq}] tool result (error=${String(failed)})\n${text === '' ? '(no text)' : text}\n`,
      }]
    }
    case 'approval/asked': {
      if (!include.has('interactions')) return []
      const id = stringOf(data?.id) ?? '?'
      const tool = stringOf(data?.toolName) ?? '?'
      const reason = stringOf(data?.reason)
      return [{
        seq: event.seq,
        text: `[${event.seq}] approval asked ${id} (tool ${tool})${reason === undefined ? '' : `\n${reason}`}\n`,
      }]
    }
    case 'approval/decided': {
      if (!include.has('interactions')) return []
      const id = stringOf(data?.id) ?? '?'
      const outcome = stringOf(data?.outcome) ?? '?'
      return [{ seq: event.seq, text: `[${event.seq}] approval decided ${id}: ${outcome}\n` }]
    }
    default:
      return []
  }
}

function questionText(args: string): string {
  try {
    const parsed = JSON.parse(args) as { questions?: { id?: string; question?: string }[] }
    if (!Array.isArray(parsed.questions)) return args
    return parsed.questions
      .map((question) => `- ${question.id ?? '?'}: ${question.question ?? ''}`)
      .join('\n')
  } catch {
    return args
  }
}

function contentText(content: unknown, kind: 'text' | 'reasoning' = 'text'): string {
  if (typeof content === 'string') return kind === 'text' ? content.trim() : ''
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const record = asRecord(block)
    if (record === undefined || record.type !== kind) continue
    const text = stringOf(record.text)
    if (text !== undefined && text.trim() !== '') parts.push(text)
  }
  return parts.join('\n').trim()
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false }
  const marker = '\n[truncated]'
  if (maxBytes <= Buffer.byteLength(marker)) {
    return { text: marker.slice(0, Math.max(0, maxBytes)), truncated: true }
  }
  const budget = maxBytes - Buffer.byteLength(marker)
  let out = ''
  let used = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (used + size > budget) break
    out += character
    used += size
  }
  return { text: `${out}${marker}`, truncated: true }
}
