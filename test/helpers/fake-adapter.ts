import type {
  AgentRun,
  PendingResponder,
  RunCancelReason,
  RunHooks,
  RunResult,
  TaskAdapter,
  TraceRead,
} from '../../src/agents/types.js'
import type { TraceEvent } from '../../src/trace.js'
import type { Pending, TaskRecord } from '../../src/types.js'

export class FakeRun implements AgentRun {
  readonly result: Promise<RunResult>
  readonly fromSeq = 100
  readonly toSeq = 110
  readonly hooks: RunHooks
  readonly taskId: string
  cancelReason?: RunCancelReason
  approved?: string
  answers?: readonly { questionId: string; selected: string[]; custom?: string }[]
  canceledPending = false
  disposed = false
  pending?: Pending
  private resolveResult!: (result: RunResult) => void
  private settled = false

  constructor(taskId: string, hooks: RunHooks) {
    this.taskId = taskId
    this.hooks = hooks
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
  }

  succeed(answer?: string): void {
    this.resolve({ status: 'succeeded', ...(answer === undefined ? {} : { answer }), fromSeq: this.fromSeq, toSeq: this.toSeq })
  }

  fail(code: string, message: string): void {
    this.resolve({ status: 'failed', error: { code, message }, fromSeq: this.fromSeq, toSeq: this.toSeq })
  }

  async cancel(reason: RunCancelReason): Promise<void> {
    this.cancelReason = reason
    this.pendingResponder?.cancel()
    this.resolve({ status: 'canceled', fromSeq: this.fromSeq, toSeq: this.toSeq })
  }

  async forceDispose(): Promise<void> {
    this.disposed = true
    this.resolve({ status: 'canceled', fromSeq: this.fromSeq, toSeq: this.toSeq })
  }

  emitApproval(requestId = 'a_1', toolName = 'bash', reason = 'needs approval'): Pending {
    const pending: Pending = {
      kind: 'approval',
      requestId,
      toolName,
      reason,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    this.pending = pending
    this.pendingResponder = {
      kind: 'approval',
      approve: (outcome) => {
        this.approved = outcome
      },
      answer: () => undefined,
      cancel: () => {
        this.canceledPending = true
      },
    }
    this.hooks.onPending(pending, this.pendingResponder)
    return pending
  }

  emitQuestion(requestId = 'q_1'): Pending {
    const pending: Pending = {
      kind: 'question',
      requestId,
      questions: [
        {
          id: 'q1',
          question: 'Which mode?',
          options: [{ label: 'fast' }, { label: 'safe' }],
          multiSelect: false,
        },
      ],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    this.pending = pending
    this.pendingResponder = {
      kind: 'question',
      approve: () => undefined,
      answer: (answers) => {
        this.answers = answers
      },
      cancel: () => {
        this.canceledPending = true
      },
    }
    this.hooks.onPending(pending, this.pendingResponder)
    return pending
  }

  progress(text: string): void {
    this.hooks.onProgress(text)
  }

  private pendingResponder?: PendingResponder

  private resolve(result: RunResult): void {
    if (this.settled) return
    this.settled = true
    this.resolveResult(result)
  }
}

export class FakeAdapter implements TaskAdapter {
  readonly runs = new Map<string, FakeRun>()
  readonly traces = new Map<string, TraceEvent[]>()
  autoAnswer?: string
  closed = false
  private readonly startedWaiters = new Map<string, (() => void)[]>()

  poolKey(record: TaskRecord): string {
    return `${record.cwd}|${record.preset}`
  }

  async start(record: TaskRecord, hooks: RunHooks): Promise<AgentRun> {
    await hooks.onSession(`s_${record.taskId}`, 100)
    const run = new FakeRun(record.taskId, hooks)
    this.runs.set(record.taskId, run)
    if (this.autoAnswer !== undefined) queueMicrotask(() => run.succeed(this.autoAnswer))
    for (const resolve of this.startedWaiters.get(record.taskId) ?? []) resolve()
    this.startedWaiters.delete(record.taskId)
    return run
  }

  async readTrace(record: TaskRecord): Promise<TraceRead> {
    const events = this.traces.get(record.taskId)
    if (events === undefined) return { unavailable: 'not_started' }
    return { events, toSeq: 110 }
  }

  health(): { pooled: number; active: number } {
    return { pooled: 0, active: this.runs.size }
  }

  async close(): Promise<void> {
    this.closed = true
    for (const run of this.runs.values()) await run.forceDispose()
    this.runs.clear()
  }

  async waitForRun(taskId: string): Promise<FakeRun> {
    const existing = this.runs.get(taskId)
    if (existing !== undefined) return existing
    return await new Promise((resolve) => {
      const waiters = this.startedWaiters.get(taskId) ?? []
      waiters.push(() => {
        const run = this.runs.get(taskId)
        if (run !== undefined) resolve(run)
      })
      this.startedWaiters.set(taskId, waiters)
    })
  }
}
