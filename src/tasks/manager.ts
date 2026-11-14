import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ResolvedConfig } from '../config.js'
import { DomainError } from '../errors.js'
import type { Logger } from '../logger.js'
import type { TraceEvent } from '../trace.js'
import { formatTrace } from '../trace.js'
import type {
  AnswerItem,
  AgentRun,
  PendingResponder,
  RunCancelReason,
  RunHooks,
  RunResult,
  TaskAdapter,
} from '../agents/types.js'
import type {
  Pending,
  TaskError,
  TaskRecord,
  TaskState,
  TaskStatus,
  TaskSummary,
  TraceInclude,
  TraceState,
  WaitInfo,
} from '../types.js'
import { isSettled, isTerminal, previewOf, toTaskState } from '../types.js'
import { TaskStore } from './store.js'

export interface SubmitInput {
  task: string
  context?: string
  cwd?: string
  sessionId?: string
  sessionMode?: 'reuse' | 'fresh'
  permissionPreset?: string
  title?: string
}

export interface WaitOptions {
  timeoutMs?: number
}

export interface WaitOutcome extends WaitInfo {
  record: TaskRecord
}

export interface TraceOptions {
  afterSeq?: number
  limit?: number
  include?: readonly TraceInclude[]
  maxBytes?: number
}

export interface TraceResult {
  content: string
  state: TraceState
}

export interface CancelResult {
  record: TaskRecord
  already: boolean
}

interface PendingRuntime {
  pending: Pending
  responder: PendingResponder
  timer: NodeJS.Timeout
}

interface SettledInteraction {
  kind: 'approval' | 'question'
  decision?: string
  answers?: string
  at: string
}

interface TaskRuntime {
  lockKey: string
  cancelRequested?: RunCancelReason
  forced?: TaskError
  pending?: PendingRuntime
  run?: AgentRun
  sessionLock?: string
  timer?: NodeJS.Timeout
  settled: Map<string, SettledInteraction>
  released: boolean
  graceTimer?: NodeJS.Timeout
}

/** Owns the task state machine, queue, sessions, interactions, and persistence. */
export class TaskManager {
  private readonly records = new Map<string, TaskRecord>()
  private readonly runtimes = new Map<string, TaskRuntime>()
  private readonly queue: string[] = []
  private readonly running = new Set<string>()
  private readonly locks = new Map<string, string>()
  private readonly sessionLocks = new Map<string, string>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly roots: string[] = []
  private pumping = false
  private closed = false
  private pruneTimer?: NodeJS.Timeout

  constructor(
    private readonly adapter: TaskAdapter,
    private readonly store: TaskStore,
    private readonly config: ResolvedConfig,
    private readonly logger: Logger,
  ) {}

  async init(): Promise<void> {
    await this.store.init()
    for (const root of this.config.workspaceRoots) {
      try {
        this.roots.push(await realpath(root))
      } catch {
        throw new Error(`workspaceRoots entry does not exist: ${root}`)
      }
    }

    const loaded = await this.store.loadAll()
    const now = new Date().toISOString()
    for (const record of loaded) {
      if (record.status === 'running' || record.status === 'waiting') {
        record.status = 'interrupted'
        record.pending = undefined
        record.finishedAt = now
        record.error = { code: 'interrupted', message: 'DSH or the plugin restarted before the task finished' }
        if (record.fromSeq !== undefined && record.toSeq === undefined) {
          try {
            const read = await this.adapter.readTrace(record, record.fromSeq)
            const last = 'events' in read ? read.events.at(-1)?.seq : undefined
            record.toSeq = last === undefined ? record.fromSeq : last + 1
          } catch {
            record.toSeq = record.fromSeq
          }
        }
        await this.store.save(record)
      }
      this.records.set(record.taskId, record)
      this.runtimes.set(record.taskId, {
        lockKey: this.lockKeyFor(record),
        settled: new Map(),
        released: false,
      })
      if (record.status === 'queued') this.queue.push(record.taskId)
    }

    const removed = await this.store.prune(
      [...this.records.values()].filter((record) => isTerminal(record.status)),
      this.config.tasks.ttlMs,
      this.config.tasks.maxRetained,
    )
    for (const taskId of removed) {
      this.records.delete(taskId)
      this.runtimes.delete(taskId)
    }

    this.refreshQueue()
    this.pump()
    const interval = Math.max(60_000, Math.min(3_600_000, Math.floor(this.config.tasks.ttlMs / 4)))
    this.pruneTimer = setInterval(() => void this.prune().catch((error: unknown) => this.logger.error('task pruning failed', { error })), interval)
    this.pruneTimer.unref()
  }

  async submit(input: SubmitInput): Promise<TaskRecord> {
    if (this.closed) throw new DomainError('internal', 'plugin is shutting down')
    const task = input.task?.trim()
    if (task === undefined || task === '') {
      throw new DomainError('invalid_request', 'task must be a non-empty string', {
        expected: 'a non-empty task string',
        actual: 'empty',
      })
    }
    if (this.queue.length >= this.config.tasks.maxQueue) {
      throw new DomainError('busy', 'queue is full', {
        expected: `fewer than ${this.config.tasks.maxQueue} queued tasks`,
      })
    }

    const cwd = await this.resolveCwd(input.cwd)
    const sessionId = input.sessionId?.trim()
    if (input.sessionId !== undefined && (sessionId === undefined || sessionId === '')) {
      throw new DomainError('invalid_request', 'sessionId must be a non-empty string')
    }
    const sessionMode = input.sessionMode ?? 'reuse'
    if (sessionMode !== 'reuse' && sessionMode !== 'fresh') {
      throw new DomainError('invalid_request', `sessionMode must be "reuse" or "fresh", got ${String(sessionMode)}`)
    }
    const title = input.title?.trim()
    const requestedPermissionPreset = input.permissionPreset?.trim()
    if (input.permissionPreset !== undefined && (requestedPermissionPreset === undefined || requestedPermissionPreset === '')) {
      throw new DomainError('invalid_request', 'permissionPreset must be a non-empty string')
    }
    if (requestedPermissionPreset !== undefined) {
      const allowed = this.config.agent.allowedPermissionPresets
      if (!allowed.includes(requestedPermissionPreset)) {
        throw new DomainError(
          'permission_denied',
          `permission preset "${requestedPermissionPreset}" is not allowed for this caller`,
          {
            expected: allowed.length === 0 ? 'no caller-selectable permission presets' : `one of: ${allowed.join(', ')}`,
            actual: requestedPermissionPreset,
          },
        )
      }
    }
    const permissionPreset = requestedPermissionPreset ?? this.config.agent.permissionPreset

    const taskId = this.newTaskId()
    const now = new Date().toISOString()
    const record: TaskRecord = {
      taskId,
      status: 'queued',
      task,
      context: input.context ?? '',
      cwd,
      sessionMode,
      preset: this.config.agent.preset,
      ...(permissionPreset === '' ? {} : { permissionPreset }),
      ...(this.config.agent.provider === '' ? {} : { provider: this.config.agent.provider }),
      ...(this.config.agent.model === '' ? {} : { model: this.config.agent.model }),
      ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
      ...(title === undefined || title === '' ? {} : { title }),
      createdAt: now,
    }
    this.records.set(taskId, record)
    this.runtimes.set(taskId, {
      lockKey: this.lockKeyFor(record),
      settled: new Map(),
      released: false,
    })
    try {
      await this.store.save(record)
    } catch (error) {
      this.records.delete(taskId)
      this.runtimes.delete(taskId)
      throw new DomainError('internal', 'could not persist the task', { cause: error })
    }
    this.queue.push(taskId)
    this.pump()
    this.logger.info('task queued', { taskId, cwd, permissionPreset, queueDepth: this.queue.length })
    return { ...record }
  }

  get(taskId: string): TaskRecord {
    return this.requireTask(taskId)
  }

  stateOf(taskId: string): TaskState {
    return toTaskState(this.requireTask(taskId), this.queueInfo(taskId))
  }

  async wait(taskId: string, options: WaitOptions = {}): Promise<TaskRecord> {
    return (await this.waitOutcome(taskId, options)).record
  }

  async waitOutcome(taskId: string, options: WaitOptions = {}): Promise<WaitOutcome> {
    const record = this.requireTask(taskId)
    const requested = options.timeoutMs ?? this.config.agent.defaultSyncWaitMs
    if (!Number.isFinite(requested) || requested < 0) {
      throw new DomainError('invalid_request', 'timeoutMs must be a non-negative number')
    }
    const requestedTimeoutMs = Math.floor(requested)
    const maxWaitMs = this.config.interactions.maxWaitMs
    const effectiveTimeoutMs = Math.min(requestedTimeoutMs, maxWaitMs)
    const wait: WaitInfo = {
      timedOut: false,
      requestedTimeoutMs,
      effectiveTimeoutMs,
      capped: effectiveTimeoutMs < requestedTimeoutMs,
      maxWaitMs,
    }
    if (isSettled(record.status)) return { ...wait, record }
    if (effectiveTimeoutMs === 0) return { ...wait, timedOut: true, record }

    await new Promise<void>((resolveWait) => {
      const set = this.waiters.get(taskId) ?? new Set<() => void>()
      this.waiters.set(taskId, set)
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        set.delete(wake)
        if (set.size === 0) this.waiters.delete(taskId)
        resolveWait()
      }
      const wake = (): void => {
        if (isSettled(this.requireTask(taskId).status)) finish()
      }
      const timer = setTimeout(finish, effectiveTimeoutMs)
      timer.unref()
      set.add(wake)
      if (isSettled(this.requireTask(taskId).status)) finish()
    })
    const current = this.requireTask(taskId)
    return { ...wait, timedOut: !isSettled(current.status), record: current }
  }

  async cancel(taskId: string): Promise<CancelResult> {
    const record = this.requireTask(taskId)
    const runtime = this.runtimeFor(taskId)
    if (isTerminal(record.status)) return { record, already: true }

    if (record.status === 'queued') {
      const index = this.queue.indexOf(taskId)
      if (index >= 0) this.queue.splice(index, 1)
      await this.finish(record, runtime, { status: 'canceled', fromSeq: 0, toSeq: 0 })
      return { record, already: false }
    }

    runtime.cancelRequested ??= 'user'
    const canceledPending = record.pending
    this.clearPending(record, runtime, 'running')
    if (canceledPending !== undefined) {
      this.auditDecision(record, canceledPending.requestId, canceledPending.kind, 'cancelled')
    }
    record.status = 'running'
    await this.saveBestEffort(record)
    this.notify(taskId)
    const run = runtime.run
    if (run !== undefined) {
      await run.cancel('user').catch(() => undefined)
      await this.awaitRun(run, record, 5_000)
    }
    if (!isTerminal(record.status)) {
      await run?.forceDispose().catch(() => undefined)
      await this.finishForced(record, runtime, 'canceled')
    }
    this.logger.info('task canceled', { taskId })
    return { record, already: this.requireTask(taskId).status !== 'canceled' }
  }

  async approve(
    taskId: string,
    requestId: string,
    decision: 'allow-once' | 'reject',
  ): Promise<{ record: TaskRecord; already: boolean }> {
    const record = this.requireTask(taskId)
    const runtime = this.runtimeFor(taskId)
    const previousApproval = runtime.settled.get(requestId)
    if (previousApproval !== undefined && previousApproval.kind === 'approval') {
      if (previousApproval.decision === decision) return { record, already: true }
      throw this.error(
        'interaction_expired',
        record,
        `The approval request ${requestId} on task ${taskId} was already resolved with a different decision.`,
      )
    }
    if (isTerminal(record.status)) throw this.error('task_terminal', record, `Task ${taskId} is already ${record.status}. Call dsh_task_get for the result.`)
    if (record.status !== 'waiting' || record.pending === undefined) {
      throw this.error('task_not_waiting', record, `Task ${taskId} is ${record.status}. Call dsh_task_get.`)
    }
    if (record.pending.kind !== 'approval') {
      throw this.error(
        'interaction_kind_mismatch',
        record,
        `Task ${taskId} is waiting for an answer, not an approval. Call dsh_task_answer with taskId="${taskId}", requestId="${record.pending.requestId}".`,
        { expected: 'answer', actual: 'approve' },
      )
    }
    if (record.pending.requestId !== requestId) {
      throw this.error(
        'interaction_not_found',
        record,
        `No pending approval with requestId "${requestId}" on task ${taskId}. Call dsh_task_get to read the current requestId.`,
      )
    }
    if (Date.now() > Date.parse(record.pending.expiresAt)) {
      throw this.error(
        'interaction_expired',
        record,
        `The approval request ${requestId} on task ${taskId} expired.`,
      )
    }

    const pending = runtime.pending
    this.clearPending(record, runtime, 'running')
    record.status = 'running'
    runtime.settled.set(requestId, { kind: 'approval', decision, at: new Date().toISOString() })
    this.auditDecision(record, requestId, 'approval', decision)
    try {
      await this.save(record)
    } catch (error) {
      runtime.forced = { code: 'internal', message: 'could not persist the approval decision' }
      runtime.cancelRequested = 'failure'
      pending?.responder.cancel()
      void runtime.run?.cancel('failure').catch(() => undefined)
      throw error
    }
    this.notify(taskId)
    pending?.responder.approve(decision === 'allow-once' ? 'allowed-once' : 'rejected')
    this.audit(record, requestId, 'approval', decision)
    return { record, already: false }
  }

  async answer(
    taskId: string,
    requestId: string,
    answers: readonly AnswerItem[],
  ): Promise<{ record: TaskRecord; already: boolean }> {
    const record = this.requireTask(taskId)
    const runtime = this.runtimeFor(taskId)
    const normalizedCandidate = JSON.stringify(
      [...answers]
        .map((answer) => ({
          questionId: answer.questionId,
          selected: [...answer.selected],
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        }))
        .sort((a, b) => a.questionId.localeCompare(b.questionId)),
    )
    const previousAnswer = runtime.settled.get(requestId)
    if (previousAnswer !== undefined && previousAnswer.kind === 'question') {
      if (previousAnswer.answers === normalizedCandidate) return { record, already: true }
      throw this.error(
        'interaction_expired',
        record,
        `The question ${requestId} on task ${taskId} was already answered differently.`,
      )
    }
    if (isTerminal(record.status)) throw this.error('task_terminal', record, `Task ${taskId} is already ${record.status}. Call dsh_task_get for the result.`)
    if (record.status !== 'waiting' || record.pending === undefined) {
      throw this.error('task_not_waiting', record, `Task ${taskId} is ${record.status}. Call dsh_task_get.`)
    }
    if (record.pending.kind !== 'question') {
      throw this.error(
        'interaction_kind_mismatch',
        record,
        `Task ${taskId} is waiting for approval, not an answer. Call dsh_task_approve with taskId="${taskId}", requestId="${record.pending.requestId}".`,
        { expected: 'approve', actual: 'answer' },
      )
    }
    if (record.pending.requestId !== requestId) {
      throw this.error(
        'interaction_not_found',
        record,
        `No pending question with requestId "${requestId}" on task ${taskId}. Call dsh_task_get to read the current requestId.`,
      )
    }
    if (Date.now() > Date.parse(record.pending.expiresAt)) {
      throw this.error(
        'interaction_expired',
        record,
        `The question request ${requestId} on task ${taskId} expired.`,
      )
    }

    const invalid = validateAnswers(record.pending, answers)
    if (invalid !== undefined) {
      throw this.error('answer_invalid', record, `Task ${taskId}: ${invalid}`, {
        expected: 'one answer item per question, with known option labels',
        actual: 'invalid answers',
      })
    }

    const normalized = normalizedCandidate
    const pending = runtime.pending
    this.clearPending(record, runtime, 'running')
    record.status = 'running'
    runtime.settled.set(requestId, { kind: 'question', answers: normalized, at: new Date().toISOString() })
    this.auditDecision(record, requestId, 'question', 'answered')
    try {
      await this.save(record)
    } catch (error) {
      runtime.forced = { code: 'internal', message: 'could not persist the answer' }
      runtime.cancelRequested = 'failure'
      pending?.responder.cancel()
      void runtime.run?.cancel('failure').catch(() => undefined)
      throw error
    }
    this.notify(taskId)
    pending?.responder.answer(answers)
    this.audit(record, requestId, 'question', answers.map((answer) => answer.questionId).join(','))
    return { record, already: false }
  }

  async trace(taskId: string, options: TraceOptions): Promise<TraceResult> {
    const record = this.requireTask(taskId)
    if (record.fromSeq === undefined) {
      throw this.error('trace_unavailable', record, 'Task has not started, so there is no trace yet. Call dsh_task_wait.')
    }
    const read = await this.adapter.readTrace(record, record.fromSeq)
    if ('unavailable' in read) {
      throw this.error(
        'trace_unavailable',
        record,
        `Trace is unavailable (${read.unavailable}). Call dsh_task_get for the result, or dsh_task_wait if it is still running.`,
      )
    }
    return formatTrace(read.events as TraceEvent[], {
      taskId,
      afterSeq: options.afterSeq,
      limit: options.limit ?? 50,
      include: options.include ?? ['messages', 'toolCalls', 'toolResults', 'interactions'],
      maxBytes: options.maxBytes ?? 64 * 1024,
    })
  }

  list(filter: { status?: TaskStatus; cwd?: string; limit?: number } = {}): TaskRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 100)
    const cwd = filter.cwd === undefined ? undefined : resolve(filter.cwd)
    return [...this.records.values()]
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .filter((record) => cwd === undefined || record.cwd === cwd)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
  }

  summaries(records: readonly TaskRecord[]): TaskSummary[] {
    return records.map((record) => ({
      taskId: record.taskId,
      preview: previewOf(record.task),
      status: record.status,
      cwd: record.cwd,
      createdAt: record.createdAt,
      ...(record.pending === undefined ? {} : { pendingKind: record.pending.kind }),
      ...(record.error === undefined ? {} : { errorCode: record.error.code }),
    }))
  }

  queueInfo(taskId: string): { queuePosition?: number; blockedBy?: string } {
    const record = this.records.get(taskId)
    if (record === undefined || record.status !== 'queued') return {}
    const runtime = this.runtimes.get(taskId)
    if (runtime === undefined) return {}
    const same = this.queue.filter((id) => {
      const other = this.records.get(id)
      const otherRuntime = this.runtimes.get(id)
      return other !== undefined && otherRuntime !== undefined && this.sameLock(record, runtime, other, otherRuntime)
    })
    const queuedAhead = Math.max(0, same.indexOf(taskId))
    const blockedBy = this.lockHolder(record, runtime)
    const position = queuedAhead + 1 + (blockedBy === undefined ? 0 : 1)
    return {
      queuePosition: position,
      ...(blockedBy === undefined ? {} : { blockedBy }),
    }
  }

  counts(): { queued: number; running: number; waiting: number } {
    let running = 0
    let waiting = 0
    for (const record of this.records.values()) {
      if (record.status === 'running') running += 1
      else if (record.status === 'waiting') waiting += 1
    }
    return { queued: this.queue.length, running, waiting }
  }

  health(): { queue: { queued: number; running: number; waiting: number }; agents: { pooled: number; active: number } } {
    return { queue: this.counts(), agents: this.adapter.health() }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.pruneTimer !== undefined) clearInterval(this.pruneTimer)
    const now = new Date().toISOString()
    for (const [taskId, record] of this.records) {
      if (isTerminal(record.status)) continue
      const runtime = this.runtimeFor(taskId)
      this.clearPending(record, runtime, 'running')
      await runtime.run?.cancel('shutdown').catch(() => undefined)
      record.status = 'interrupted'
      record.finishedAt = now
      record.error = { code: 'interrupted', message: 'plugin shutdown before the task finished' }
      await this.store.save(record).catch(() => undefined)
      this.notify(taskId)
    }
    await Promise.allSettled(
      [...this.runtimes.values()].map(async (runtime) => {
        if (runtime.run !== undefined) {
          await Promise.race([
            runtime.run.result.catch(() => undefined),
            new Promise((resolveWait) => setTimeout(resolveWait, 2_000).unref()),
          ])
          await runtime.run.forceDispose().catch(() => undefined)
        }
      }),
    )
    await this.adapter.close()
    await this.store.close()
    this.records.clear()
    this.runtimes.clear()
    this.queue.length = 0
    this.running.clear()
    this.locks.clear()
    this.sessionLocks.clear()
    this.waiters.clear()
  }

  private async runTask(record: TaskRecord): Promise<void> {
    const runtime = this.runtimeFor(record.taskId)
    try {
      record.status = 'running'
      record.startedAt ??= new Date().toISOString()
      await this.save(record)
      this.notify(record.taskId)

      const hooks: RunHooks = {
        onSession: async (sessionId, fromSeq) => {
          record.sessionId = sessionId
          record.fromSeq = fromSeq
          runtime.sessionLock = sessionId
          this.sessionLocks.set(sessionId, record.taskId)
          await this.save(record)
        },
        onProgress: (progress) => {
          if (isTerminal(record.status) || record.progress === progress) return
          record.progress = progress
          this.saveInBackground(record)
        },
        onPending: (pending, responder) => this.onPending(record, runtime, pending, responder),
        onSettled: (requestId) => {
          if (runtime.pending?.pending.requestId !== requestId) return
          // The bridge settled outside a manager decision (for example the
          // host aborted the turn). Do not leave a stale approval behind.
          this.clearPending(record, runtime, 'running')
          this.saveInBackground(record)
          this.notify(record.taskId)
        },
        onUnavailable: (kind, message) => this.onUnavailable(record, runtime, kind, message),
      }

      const run = await this.adapter.start(record, hooks)
      runtime.run = run
      if (runtime.cancelRequested !== undefined || this.closed) {
        await run.cancel(runtime.cancelRequested ?? 'shutdown')
      }
      const timeoutMs = this.config.agent.defaultTimeoutMs
      runtime.timer = setTimeout(() => void this.timeoutTask(record, runtime).catch((error: unknown) => this.logger.error('task timeout handling failed', { taskId: record.taskId, error })), timeoutMs)
      runtime.timer.unref()

      const result = await run.result
      if (runtime.timer !== undefined) clearTimeout(runtime.timer)
      if (isTerminal(record.status)) return
      if (runtime.forced !== undefined) {
        await this.finish(record, runtime, { ...result, status: 'failed', error: runtime.forced })
      } else {
        await this.finish(record, runtime, result)
      }
    } catch (error) {
      if (!isTerminal(record.status)) {
        const domain = error instanceof DomainError ? error : undefined
        await this.finish(record, runtime, {
          status: 'failed',
          fromSeq: record.fromSeq ?? 0,
          toSeq: this.currentSeq(runtime, record),
          error: {
            code: domain?.code ?? 'agent_unavailable',
            message: domain?.message ?? (error instanceof Error ? error.message : String(error)),
          },
        })
      }
    } finally {
      if (runtime.timer !== undefined) clearTimeout(runtime.timer)
      if (runtime.graceTimer !== undefined) clearTimeout(runtime.graceTimer)
      if (runtime.sessionLock !== undefined) {
        if (this.sessionLocks.get(runtime.sessionLock) === record.taskId) {
          this.sessionLocks.delete(runtime.sessionLock)
        }
      }
      if (!runtime.released) {
        runtime.released = true
        this.locks.delete(runtime.lockKey)
        this.running.delete(record.taskId)
        this.pump()
      }
    }
  }

  private async finish(record: TaskRecord, runtime: TaskRuntime, result: RunResult): Promise<void> {
    if (isTerminal(record.status)) return
    if (runtime.pending !== undefined) this.clearPending(record, runtime, record.status)
    record.fromSeq ??= result.fromSeq
    if (record.fromSeq !== undefined && result.toSeq >= record.fromSeq) record.toSeq = result.toSeq
    record.pending = undefined
    record.finishedAt = new Date().toISOString()
    if (result.status === 'succeeded') {
      record.status = 'succeeded'
      if (result.answer !== undefined && result.answer.trim() !== '') {
        record.answer = truncateAnswer(result.answer, this.config.agent.maxAnswerBytes)
      }
      record.error = undefined
    } else if (result.status === 'canceled') {
      record.status = 'canceled'
      record.error = undefined
    } else {
      record.status = 'failed'
      record.error = result.error ?? { code: 'agent_failed', message: 'task failed' }
    }
    await this.save(record)
    this.notify(record.taskId)
    this.logger.info(`task ${record.status}`, {
      taskId: record.taskId,
      sessionId: record.sessionId,
      durationMs: record.startedAt === undefined ? undefined : Date.now() - Date.parse(record.startedAt),
      errorCode: record.error?.code,
    })
  }

  private onPending(record: TaskRecord, runtime: TaskRuntime, pending: Pending, responder: PendingResponder): void {
    if (this.closed || isTerminal(record.status)) {
      responder.cancel()
      return
    }
    if (runtime.pending !== undefined) {
      this.logger.warn('second interaction while one is pending', { taskId: record.taskId })
      responder.cancel()
      return
    }
    const timeoutMs =
      pending.kind === 'approval'
        ? this.config.interactions.approvalTimeoutMs
        : this.config.interactions.questionTimeoutMs
    const timer = setTimeout(() => void this.expirePending(record.taskId, pending.requestId).catch((error: unknown) => this.logger.error('pending expiry failed', { taskId: record.taskId, error })), timeoutMs)
    timer.unref()
    runtime.pending = { pending, responder, timer }
    record.pending = pending
    record.status = 'waiting'
    this.saveInBackground(record)
    this.notify(record.taskId)
    this.logger.info('task waiting', { taskId: record.taskId, kind: pending.kind })
  }

  private async expirePending(taskId: string, requestId: string): Promise<void> {
    const record = this.records.get(taskId)
    const runtime = this.runtimes.get(taskId)
    if (record === undefined || runtime === undefined) return
    if (record.status !== 'waiting' || record.pending?.requestId !== requestId) return
    const kind = record.pending.kind
    const pending = runtime.pending
    this.auditDecision(record, requestId, kind, 'timeout')
    this.clearPending(record, runtime, 'running')
    runtime.forced = {
      code: kind === 'approval' ? 'approval_timeout' : 'question_timeout',
      message: `${kind} request timed out after ${kind === 'approval' ? this.config.interactions.approvalTimeoutMs : this.config.interactions.questionTimeoutMs} ms`,
    }
    runtime.cancelRequested ??= 'timeout'
    await this.saveBestEffort(record)
    this.notify(taskId)
    pending?.responder.cancel()
    const run = runtime.run
    if (run !== undefined) {
      await run.cancel('timeout').catch(() => undefined)
      this.graceFinalize(record, runtime, run)
    } else {
      await this.finishForced(record, runtime, 'failed', runtime.forced)
    }
  }

  private async timeoutTask(record: TaskRecord, runtime: TaskRuntime): Promise<void> {
    if (isTerminal(record.status)) return
    runtime.forced = {
      code: 'timeout',
      message: `timeout after ${this.config.agent.defaultTimeoutMs} ms`,
    }
    runtime.cancelRequested ??= 'timeout'
    const pending = runtime.pending
    if (pending !== undefined) this.auditDecision(record, pending.pending.requestId, pending.pending.kind, 'timeout')
    this.clearPending(record, runtime, 'running')
    await this.saveBestEffort(record)
    this.notify(record.taskId)
    pending?.responder.cancel()
    const run = runtime.run
    if (run !== undefined) {
      await run.cancel('timeout').catch(() => undefined)
      this.graceFinalize(record, runtime, run)
    } else {
      await this.finishForced(record, runtime, 'failed', runtime.forced)
    }
  }

  private onUnavailable(
    record: TaskRecord,
    runtime: TaskRuntime,
    kind: 'approval' | 'question',
    message: string,
  ): void {
    if (isTerminal(record.status)) return
    runtime.forced = {
      code: kind === 'approval' ? 'approval_required' : 'question_unavailable',
      message,
    }
    runtime.cancelRequested ??= 'failure'
    const pending = runtime.pending
    if (pending !== undefined) this.auditDecision(record, pending.pending.requestId, pending.pending.kind, 'unavailable')
    this.clearPending(record, runtime, 'running')
    this.saveInBackground(record)
    pending?.responder.cancel()
    const run = runtime.run
    if (run === undefined) {
      void this.finishForced(record, runtime, 'failed', runtime.forced).catch((error: unknown) => {
        this.logger.error('forced finalization failed', { taskId: record.taskId, error })
      })
      return
    }
    void run.cancel('failure').catch((error: unknown) => {
      this.logger.warn('agent cancel failed during forced failure', { taskId: record.taskId, error })
    })
    this.graceFinalize(record, runtime, run)
  }

  private graceFinalize(record: TaskRecord, runtime: TaskRuntime, run: AgentRun): void {
    if (runtime.graceTimer !== undefined) clearTimeout(runtime.graceTimer)
    runtime.graceTimer = setTimeout(() => {
      if (isTerminal(record.status)) return
      void (async () => {
        await run.forceDispose().catch(() => undefined)
        await this.finishForced(
          record,
          runtime,
          'failed',
          runtime.forced ?? { code: 'timeout', message: 'task timed out' },
        )
        if (!runtime.released) {
          runtime.released = true
          this.locks.delete(runtime.lockKey)
          this.running.delete(record.taskId)
          this.pump()
        }
      })().catch((error: unknown) => {
        this.logger.error('graceful finalization failed', { taskId: record.taskId, error })
      })
    }, 5_000)
    runtime.graceTimer.unref()
  }

  private clearPending(record: TaskRecord, runtime: TaskRuntime, nextStatus: TaskStatus): void {
    const pending = runtime.pending
    if (pending !== undefined) {
      clearTimeout(pending.timer)
      runtime.pending = undefined
    }
    record.pending = undefined
    if (!isTerminal(record.status)) record.status = nextStatus
  }

  private async awaitRun(run: AgentRun, record: TaskRecord, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      run.result.catch(() => undefined),
      new Promise<void>((resolveWait) => {
        timer = setTimeout(resolveWait, timeoutMs)
        timer.unref()
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
  }

  private pump(): void {
    if (this.pumping || this.closed) return
    this.pumping = true
    queueMicrotask(() => {
      void (async () => {
        let started = false
        try {
          while (!this.closed && this.running.size < this.config.agent.maxConcurrent) {
            const taskId = this.queue.find((id) => {
              const record = this.records.get(id)
              const runtime = this.runtimes.get(id)
              return record !== undefined && runtime !== undefined && !this.isLocked(record, runtime)
            })
            if (taskId === undefined) break
            const record = this.records.get(taskId)
            const runtime = this.runtimes.get(taskId)
            if (record === undefined || runtime === undefined) {
              this.queue.splice(this.queue.indexOf(taskId), 1)
              continue
            }
            this.queue.splice(this.queue.indexOf(taskId), 1)
            this.locks.set(runtime.lockKey, taskId)
            this.running.add(taskId)
            started = true
            void this.runTask(record).catch((error: unknown) => this.logger.error('task worker failed', { taskId: record.taskId, error }))
          }
        } finally {
          this.pumping = false
          if (started && !this.closed && this.running.size < this.config.agent.maxConcurrent && this.queue.length > 0) {
            this.pump()
          }
        }
      })()
    })
  }

  private isLocked(record: TaskRecord, runtime: TaskRuntime): boolean {
    if (this.locks.has(runtime.lockKey)) return true
    return record.sessionId !== undefined && this.sessionLocks.has(record.sessionId)
  }

  private lockHolder(record: TaskRecord, runtime: TaskRuntime): string | undefined {
    return this.locks.get(runtime.lockKey) ??
      (record.sessionId === undefined ? undefined : this.sessionLocks.get(record.sessionId))
  }

  private sameLock(
    record: TaskRecord,
    runtime: TaskRuntime,
    other: TaskRecord,
    otherRuntime: TaskRuntime,
  ): boolean {
    if (runtime.lockKey === otherRuntime.lockKey) return true
    return record.sessionId !== undefined && record.sessionId === other.sessionId
  }

  private refreshQueue(): void {
    // Queue positions are computed on read; this hook exists for symmetry with
    // future queue policy and to validate ids after recovery.
    for (const taskId of [...this.queue]) {
      if (!this.records.has(taskId)) this.queue.splice(this.queue.indexOf(taskId), 1)
    }
  }

  private async prune(): Promise<void> {
    if (this.closed) return
    const removed = await this.store.prune(
      [...this.records.values()].filter((record) => isTerminal(record.status)),
      this.config.tasks.ttlMs,
      this.config.tasks.maxRetained,
    )
    for (const taskId of removed) {
      this.records.delete(taskId)
      this.runtimes.delete(taskId)
    }
  }

  private async saveBestEffort(record: TaskRecord): Promise<void> {
    try {
      await this.save(record)
    } catch (error) {
      this.logger.error('task persistence failed during transition', { taskId: record.taskId, error })
    }
  }

  private saveInBackground(record: TaskRecord): void {
    void this.save(record).catch((error: unknown) => {
      this.logger.error('background task persistence failed', { taskId: record.taskId, error })
    })
  }

  private async save(record: TaskRecord): Promise<void> {
    try {
      await this.store.save(record)
    } catch (error) {
      this.logger.error('task persistence failed', { taskId: record.taskId, error })
      throw new DomainError('internal', 'could not persist the task state', { cause: error })
    }
  }

  private notify(taskId: string): void {
    const set = this.waiters.get(taskId)
    if (set === undefined) return
    for (const resolveWait of [...set]) resolveWait()
  }

  private requireTask(taskId: string): TaskRecord {
    const record = this.records.get(taskId)
    if (record === undefined) {
      throw new DomainError('task_not_found', `Task ${taskId} was not found. Check the id or call dsh_task_list.`)
    }
    return record
  }

  private runtimeFor(taskId: string): TaskRuntime {
    let runtime = this.runtimes.get(taskId)
    if (runtime === undefined) {
      runtime = { lockKey: `task:${taskId}`, settled: new Map(), released: false }
      this.runtimes.set(taskId, runtime)
    }
    return runtime
  }

  private lockKeyFor(record: TaskRecord): string {
    if (record.sessionId !== undefined) return `session:${record.sessionId}`
    if (record.sessionMode === 'fresh') return `fresh:${record.taskId}`
    return `pool:${this.adapter.poolKey(record)}`
  }

  private newTaskId(): string {
    for (;;) {
      const id = `t_${randomUUID().replaceAll('-', '').slice(0, 12)}`
      if (!this.records.has(id)) return id
    }
  }

  private async resolveCwd(raw: string | undefined): Promise<string> {
    const candidate = raw ?? process.cwd()
    if (!isAbsolute(candidate)) {
      throw new DomainError('cwd_not_found', `cwd must be an existing absolute directory, got ${candidate}`, {
        expected: 'an absolute directory',
        actual: candidate,
      })
    }
    let canonical: string
    try {
      canonical = await realpath(candidate)
    } catch (error) {
      throw new DomainError('cwd_not_found', `cwd does not exist: ${candidate}`, {
        expected: 'an existing absolute directory',
        actual: candidate,
        cause: error,
      })
    }
    if (this.roots.length > 0) {
      const allowed = this.roots.some((root) => {
        const rel = relative(root, canonical)
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      })
      if (!allowed) {
        throw new DomainError('cwd_forbidden', `cwd is outside workspaceRoots: ${canonical}`, {
          expected: this.roots.join(', '),
          actual: canonical,
        })
      }
    }
    return canonical
  }

  private async finishForced(
    record: TaskRecord,
    runtime: TaskRuntime,
    status: 'failed' | 'canceled',
    error?: TaskError,
  ): Promise<void> {
    const end = await this.knownEndSeq(record)
    await this.finish(record, runtime, {
      status,
      fromSeq: record.fromSeq ?? 0,
      toSeq: end ?? record.fromSeq ?? 0,
      ...(error === undefined ? {} : { error }),
    })
  }

  private async knownEndSeq(record: TaskRecord): Promise<number | undefined> {
    if (record.fromSeq === undefined) return undefined
    try {
      const read = await this.adapter.readTrace(record, record.fromSeq)
      return 'events' in read ? read.toSeq : record.fromSeq
    } catch {
      return record.fromSeq
    }
  }

  private currentSeq(runtime: TaskRuntime, record: TaskRecord): number {
    return record.toSeq ?? record.fromSeq ?? 0
  }

  private error(
    code: ConstructorParameters<typeof DomainError>[0],
    record: TaskRecord,
    message: string,
    extra: { expected?: string; actual?: string } = {},
  ): DomainError {
    return new DomainError(code, message, {
      ...extra,
      state: toTaskState(record, this.queueInfo(record.taskId)),
    })
  }

  private auditDecision(
    record: TaskRecord,
    requestId: string,
    kind: 'approval' | 'question',
    decision: string,
  ): void {
    const entry = { requestId, kind, decision, at: new Date().toISOString() }
    record.decisions = [...(record.decisions ?? []), entry]
  }

  private audit(record: TaskRecord, requestId: string, kind: string, decision: string): void {
    this.logger.info('interaction decided', {
      taskId: record.taskId,
      requestId,
      kind,
      decision,
      at: new Date().toISOString(),
    })
  }
}

function validateAnswers(pending: Pending & { kind: 'question' }, answers: readonly AnswerItem[]): string | undefined {
  if (!Array.isArray(answers) || answers.length !== pending.questions.length) {
    return `answers must contain exactly ${pending.questions.length} item(s).`
  }
  const ids = new Set(pending.questions.map((question) => question.id))
  const seen = new Set<string>()
  for (const answer of answers) {
    if (typeof answer.questionId !== 'string' || !ids.has(answer.questionId)) {
      return `Unknown question id "${String(answer.questionId)}".`
    }
    if (seen.has(answer.questionId)) return `Duplicate answer for question "${answer.questionId}".`
    seen.add(answer.questionId)
    if (!Array.isArray(answer.selected) || answer.selected.some((label: unknown) => typeof label !== 'string')) {
      return `selected must be an array of option labels for question "${answer.questionId}".`
    }
    if (answer.custom !== undefined && typeof answer.custom !== 'string') {
      return `custom must be a string for question "${answer.questionId}".`
    }
    const question = pending.questions.find((item) => item.id === answer.questionId)
    const labels = new Set((question?.options ?? []).map((option) => option.label))
    for (const selected of answer.selected) {
      if (!labels.has(selected)) return `Unknown option "${selected}" for question "${answer.questionId}".`
    }
    if (answer.selected.length === 0 && (answer.custom === undefined || answer.custom.trim() === '')) {
      return `Question "${answer.questionId}" needs a selected option or custom text.`
    }
  }
  return undefined
}

function truncateAnswer(answer: string, maxBytes: number): string {
  if (Buffer.byteLength(answer) <= maxBytes) return answer
  const marker = '\n\n[truncated]'
  if (maxBytes <= Buffer.byteLength(marker)) return marker.slice(0, Math.max(0, maxBytes))
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker))
  let end = Math.min(answer.length, budget)
  while (end > 0 && Buffer.byteLength(answer.slice(0, end)) > budget) end -= 1
  return `${answer.slice(0, end).trimEnd()}${marker}`
}
