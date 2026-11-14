import type { TraceEvent } from '../../src/trace.js'

export interface DshMessage {
  id: string
  role: 'user'
  content: { type: 'text'; text: string }[]
  source: { kind: string }
}

export class FakeSession {
  readonly events: TraceEvent[] = []
  readonly header: { cwd?: string }
  seq = 0

  constructor(
    readonly id: string,
    cwd: string | undefined,
  ) {
    this.header = cwd === undefined ? {} : { cwd }
  }

  append(type: string, data: unknown): TraceEvent {
    const event: TraceEvent = { seq: this.seq, type, data }
    this.seq += 1
    this.events.push(event)
    return event
  }

  snapshotEvents(fromSeq = 0, toSeqExclusive = this.events.length): readonly TraceEvent[] {
    return this.events.slice(fromSeq, toSeqExclusive)
  }
}

export interface FakeAgentScript {
  onFollowup?: (agent: FakeAgent) => void | Promise<void>
}

export class FakeAgent {
  readonly id: string
  readonly session: FakeSession
  readonly ctx: {
    on: (event: string, listener: (...args: never[]) => unknown) => () => void
  }
  readonly messages: DshMessage[] = []
  status: 'idle' | 'running' = 'idle'
  disposed = false
  cancelCause?: string
  approvals: string[] = []
  questions: { answers: { id: string; selected: string[]; custom?: string }[] }[] = []
  script: FakeAgentScript = {}
  private readonly approvalListeners: ((req: unknown, next: () => Promise<string>) => Promise<string>)[] = []
  private readonly questionListeners: ((req: unknown, next: () => Promise<unknown>) => Promise<unknown>)[] = []
  private idleWaiters: (() => void)[] = []

  constructor(id: string, cwd: string | undefined) {
    this.id = id
    this.session = new FakeSession(id, cwd)
    this.ctx = {
      on: (event, listener) => {
        if (event === 'approval/request') {
          const typed = listener as unknown as (req: unknown, next: () => Promise<string>) => Promise<string>
          this.approvalListeners.push(typed)
          return () => {
            const index = this.approvalListeners.indexOf(typed)
            if (index >= 0) this.approvalListeners.splice(index, 1)
          }
        }
        if (event === 'user-questions/request') {
          const typed = listener as unknown as (req: unknown, next: () => Promise<unknown>) => Promise<unknown>
          this.questionListeners.push(typed)
          return () => {
            const index = this.questionListeners.indexOf(typed)
            if (index >= 0) this.questionListeners.splice(index, 1)
          }
        }
        return () => undefined
      },
    }
  }

  followup(message: DshMessage): void {
    this.messages.push(message)
    this.session.append('user/message', { role: 'user', content: message.content, source: message.source })
    this.status = 'running'
    queueMicrotask(() => {
      void Promise.resolve(this.script.onFollowup?.(this) ?? this.complete('ok')).then(
        () => undefined,
        (error: unknown) => this.complete(`error: ${String(error)}`),
      )
    })
  }

  whenIdle(): Promise<void> {
    if (this.status === 'idle') return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  cancel(cause: { kind: string }): void {
    this.cancelCause = cause.kind
    if (this.status === 'running') {
      this.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    }
    this.status = 'idle'
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  complete(answer?: string): void {
    if (this.status === 'running') {
      if (answer !== undefined) {
        this.session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: answer }] },
          stream: [],
        })
      }
      this.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    this.status = 'idle'
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  fail(message: string): void {
    this.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message } } })
    this.status = 'idle'
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  async requestApproval(toolName = 'bash', reason = 'needs approval'): Promise<string> {
    for (const listener of this.approvalListeners) {
      const outcome = await listener({ toolName, reason }, async () => 'unavailable')
      this.approvals.push(outcome)
      return outcome
    }
    this.approvals.push('unavailable')
    return 'unavailable'
  }

  async requestQuestion(questions: readonly {
    id: string
    question: string
    options?: { label: string }[]
    multiSelect?: boolean
  }[] = [{ id: 'q1', question: 'Pick', options: [{ label: 'fast' }, { label: 'safe' }] }]): Promise<unknown> {
    for (const listener of this.questionListeners) {
      const answer = await listener({ questions }, async () => ({ answers: [] }))
      this.questions.push(answer as { answers: { id: string; selected: string[]; custom?: string }[] })
      return answer
    }
    return undefined
  }

  dispose(): void {
    this.disposed = true
    this.cancel({ kind: 'disposed' })
  }
}

export class FakePersistence {
  readonly sessions = new Map<string, { header: { cwd?: string }; events: TraceEvent[] }>()

  async open(id: string, access: 'read' | 'write'): Promise<{
    read(offset?: number, length?: number): Promise<{ events: TraceEvent[] }>
    close(): Promise<void>
  }> {
    if (access !== 'read') throw new Error('fake persistence is read-only')
    const stored = this.sessions.get(id)
    if (stored === undefined) {
      const error = new Error(`session not found: ${id}`)
      error.name = 'SessionPersistenceNotFoundError'
      throw error
    }
    return {
      read: async (offset = 0, length?: number) => ({
        events: stored.events.slice(offset, length === undefined ? undefined : offset + length),
      }),
      close: async () => undefined,
    }
  }
}

export class FakeDshContext {
  readonly agentsById = new Map<string, FakeAgent>()
  readonly created: unknown[] = []
  readonly resumed: unknown[] = []
  readonly mounts: string[] = []
  readonly permissionSets: { sessionId: string; name: string }[] = []
  permissionPresetsAvailable = true
  readonly persistence = new FakePersistence()
  modelSelection: { provider: string; model: string; reasoningEffort?: string } | undefined = {
    provider: 'deepseek-official',
    model: 'deepseek-chat',
  }
  onFollowup?: (agent: FakeAgent) => void | Promise<void>
  failCreate?: Error
  failResume?: Error
  persistCwd?: string
  createGate?: Promise<void>

  readonly agents = {
    create: async (options: {
      sessionId: string
      meta: { cwd: string; agentPreset: string }
      agentOptions: Record<string, unknown>
      setup: (ctx: FakeAgent['ctx']) => Promise<void>
    }) => {
      if (this.createGate !== undefined) await this.createGate
      if (this.failCreate !== undefined) throw this.failCreate
      this.created.push(options)
      const agent = new FakeAgent(options.sessionId, options.meta.cwd)
      agent.script.onFollowup = this.onFollowup
      this.agentsById.set(agent.id, agent)
      this.persistence.sessions.set(agent.id, { header: agent.session.header, events: agent.session.events })
      await options.setup(agent.ctx)
      return {
        agent,
        dispose: async () => {
          agent.dispose()
          this.agentsById.delete(agent.id)
        },
      }
    },
    resume: async (options: {
      resumeSessionId: string
      agentOptions: Record<string, unknown>
      setup: (ctx: FakeAgent['ctx']) => Promise<void>
    }) => {
      if (this.failResume !== undefined) throw this.failResume
      this.resumed.push(options)
      const stored = this.persistence.sessions.get(options.resumeSessionId)
      if (stored === undefined) throw new Error('not found')
      if (this.agentsById.has(options.resumeSessionId)) throw new Error('already live')
      const agent = new FakeAgent(options.resumeSessionId, stored.header.cwd ?? this.persistCwd)
      agent.script.onFollowup = this.onFollowup
      this.agentsById.set(agent.id, agent)
      await options.setup(agent.ctx)
      return {
        agent,
        dispose: async () => {
          agent.dispose()
          this.agentsById.delete(agent.id)
        },
      }
    },
    get: (id: string) => this.agentsById.get(id),
  }

  readonly agentPresets = {
    mount: async (_ctx: FakeAgent['ctx'], preset: string) => {
      if (preset === 'missing') throw new Error('preset not found')
      this.mounts.push(preset)
      return { id: preset }
    },
  }

  readonly permissionPresets = {
    names: ['workspace-write', 'auto'],
    set: (session: FakeSession, name: string) => {
      if (name === 'missing') throw new Error('unknown preset')
      this.permissionSets.push({ sessionId: session.id, name })
      session.append('permission/preset', { preset: name })
    },
  }

  get(name: string): unknown {
    if (name === 'permissionPresets') return this.permissionPresetsAvailable ? this.permissionPresets : undefined
    switch (name) {
      case 'agentDefaultModel':
        return { currentSelection: () => this.modelSelection }
      case 'sessions':
        return { flush: async () => undefined }
      case 'sessionPersistence':
        return this.persistence
      case 'sessionTitle':
        return { rename: () => undefined }
      case 'workspaceRegistry':
        return undefined
      default:
        return undefined
    }
  }
}
