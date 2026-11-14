import { randomUUID } from 'node:crypto'
import type { Logger } from '../logger.js'
import type { InteractionMode } from '../config.js'
import type { Pending } from '../types.js'
import type { AnswerItem, PendingResponder, RunHooks } from './types.js'

type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

interface ApprovalRequest {
  agent?: { id?: string; session?: { id?: string } }
  toolName?: string
  reason?: string
  displayReason?: Record<string, string>
  signal?: AbortSignal
}

interface QuestionOption {
  label: string
  description?: string
}

interface QuestionItem {
  id: string
  question: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

interface QuestionRequest {
  agent?: { id?: string; session?: { id?: string } }
  questions?: QuestionItem[]
  signal?: AbortSignal
}

interface QuestionAnswer {
  answers: { id: string; selected: string[]; custom?: string }[]
}

interface EventContext {
  on?: (
    event: string,
    listener: (...args: never[]) => unknown,
    options?: { prepend?: boolean },
  ) => unknown
}

interface ActivePending {
  requestId: string
  kind: 'approval' | 'question'
  taskId: string
  signal?: AbortSignal
  abort?: () => void
  resolveApproval?: (outcome: ApprovalOutcome) => void
  resolveQuestion?: (value: QuestionAnswer) => void
  rejectQuestion?: (error: Error) => void
}

/**
 * Per-session routing bridge for DSH's approval and question waterfalls.
 * It only claims requests while a plugin task is driving the session.
 */
export class SessionInteractionBridge {
  private currentTaskId: string | undefined
  private hooks: RunHooks | undefined
  private autoReview = false
  private requireAgentMatch = false
  private active: ActivePending | undefined
  private registered = false
  private readonly detachers: (() => void)[] = []

  constructor(
    readonly sessionId: string,
    private readonly mode: InteractionMode,
    private readonly approvalTimeoutMs: number,
    private readonly questionTimeoutMs: number,
    private readonly logger: Logger,
  ) {}

  get pendingRequestId(): string | undefined {
    return this.active?.requestId
  }

  beginTask(taskId: string, hooks: RunHooks, autoReview = false): void {
    if (this.currentTaskId !== undefined && this.currentTaskId !== taskId) {
      this.cancelPending()
    }
    this.currentTaskId = taskId
    this.hooks = hooks
    this.autoReview = autoReview
  }

  endTask(taskId: string): void {
    if (this.currentTaskId !== taskId) return
    this.cancelPending()
    this.currentTaskId = undefined
    this.hooks = undefined
    this.autoReview = false
  }

  /**
   * Register approval/question routing. Register on the plugin root when its
   * events are globally visible and pass `requireAgentMatch`; otherwise use the
   * agent-scoped context, which already filters by agent.
   */
  register(ctx: EventContext, requireAgentMatch = false): void {
    if (this.registered) return
    this.registered = true
    this.requireAgentMatch = requireAgentMatch
    if (typeof ctx.on !== 'function') {
      this.logger.warn('agent context has no event API; interactions will fail closed', {
        sessionId: this.sessionId,
      })
      return
    }
    const options = requireAgentMatch ? { prepend: true } : undefined
    this.listen(ctx, 'approval/request', (request, next) => this.handleApproval(request, next), options)
    this.listen(ctx, 'user-questions/request', (request, next) => this.handleQuestion(request, next), options)
  }

  /** Resolve the active approval/question. Returns false when nothing matched. */
  approve(outcome: 'allowed-once' | 'rejected'): boolean {
    const active = this.active
    if (active === undefined || active.kind !== 'approval' || active.resolveApproval === undefined) return false
    this.settle(active)
    active.resolveApproval(outcome)
    return true
  }

  /** Answer a pending question; kept separate to preserve the Promise type. */
  resolveQuestion(answers: readonly AnswerItem[]): boolean {
    const active = this.active
    if (active === undefined || active.kind !== 'question' || active.resolveQuestion === undefined) return false
    const resolve = active.resolveQuestion
    this.settle(active)
    resolve({
      answers: answers.map((answer) => ({
        id: answer.questionId,
        selected: [...answer.selected],
        ...(answer.custom === undefined ? {} : { custom: answer.custom }),
      })),
    })
    return true
  }

  cancelPending(): boolean {
    const active = this.active
    if (active === undefined) return false
    this.settle(active)
    if (active.resolveApproval !== undefined) {
      active.resolveApproval('cancelled')
    } else {
      active.rejectQuestion?.(new Error('interaction canceled'))
    }
    return true
  }

  detach(): void {
    this.cancelPending()
    for (const detach of this.detachers.splice(0)) {
      try {
        detach()
      } catch {
        // The owning context may already be unwound.
      }
    }
    this.registered = false
  }

  private listen(
    ctx: EventContext,
    event: string,
    handler: (...args: never[]) => unknown,
    options?: { prepend?: boolean },
  ): void {
    const result = ctx.on?.(event, handler as (...args: never[]) => unknown, options)
    if (typeof result === 'function') this.detachers.push(result as () => void)
  }

  private matchesSession(request: { agent?: { id?: string; session?: { id?: string } } }): boolean {
    if (!this.requireAgentMatch) return true
    return request.agent?.id === this.sessionId || request.agent?.session?.id === this.sessionId
  }

  private async handleApproval(request: ApprovalRequest, next: () => Promise<ApprovalOutcome>): Promise<ApprovalOutcome> {
    if (!this.matchesSession(request)) return next()
    const taskId = this.currentTaskId
    const hooks = this.hooks
    if (taskId === undefined || hooks === undefined) return next()
    if (this.active !== undefined) {
      this.logger.warn('approval requested while another interaction is pending', { sessionId: this.sessionId, taskId })
      return 'unavailable'
    }
    if (this.mode === 'deny') {
      hooks.onUnavailable('approval', 'approval is required but interactions.mode is "deny"')
      return 'unavailable'
    }
    // Auto review is the guardrail for full access. Never hand its denials to
    // the remote caller, who could otherwise override the reviewer. Delegate to
    // later host answerers; with no answerer the approval fails closed.
    if (this.autoReview) return await next()

    if (this.mode === 'host') {
      const outcome = await next()
      if (outcome === 'unavailable') {
        hooks.onUnavailable('approval', 'no host answerer claimed the approval request')
      }
      return outcome
    }

    const requestId = `a_${randomUUID()}`
    const expiresAt = new Date(Date.now() + this.approvalTimeoutMs).toISOString()
    const pending: Pending = {
      kind: 'approval',
      requestId,
      toolName: request.toolName ?? 'unknown',
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      expiresAt,
    }
    return await new Promise<ApprovalOutcome>((resolve) => {
      const active: ActivePending = {
        requestId,
        kind: 'approval',
        taskId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        resolveApproval: resolve,
      }
      this.attachAbort(active, () => {
        this.settle(active)
        resolve('cancelled')
      })
      this.active = active
      const responder: PendingResponder = {
        kind: 'approval',
        approve: (outcome) => this.approve(outcome),
        answer: () => undefined,
        cancel: () => this.cancelPending(),
      }
      try {
        hooks.onPending(pending, responder)
      } catch (error) {
        this.active = undefined
        this.removeAbort(active)
        this.logger.warn('approval could not be registered', { sessionId: this.sessionId, error })
        resolve('unavailable')
      }
    })
  }

  private async handleQuestion(request: QuestionRequest, next: () => Promise<QuestionAnswer>): Promise<QuestionAnswer> {
    if (!this.matchesSession(request)) return next()
    const taskId = this.currentTaskId
    const hooks = this.hooks
    if (taskId === undefined || hooks === undefined) return next()
    if (this.active !== undefined) throw new Error('another interaction is already pending')
    if (this.mode === 'deny') {
      hooks.onUnavailable('question', 'a user question is required but interactions.mode is "deny"')
      throw new Error('user questions are unavailable')
    }
    if (this.mode === 'host') {
      try {
        return await next()
      } catch (error) {
        hooks.onUnavailable('question', error instanceof Error ? error.message : String(error))
        throw error
      }
    }

    const requestId = `q_${randomUUID()}`
    const expiresAt = new Date(Date.now() + this.questionTimeoutMs).toISOString()
    const questions = (request.questions ?? []).map((question) => ({
      id: question.id,
      question: question.question,
      ...(question.options === undefined
        ? {}
        : {
            options: question.options.map((option) => ({
              label: option.label,
              ...(option.description === undefined ? {} : { description: option.description }),
            })),
          }),
      ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
    }))
    const pending: Pending = { kind: 'question', requestId, questions, expiresAt }
    return await new Promise<QuestionAnswer>((resolve, reject) => {
      const active: ActivePending = {
        requestId,
        kind: 'question',
        taskId,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        resolveQuestion: resolve,
        rejectQuestion: reject,
      }
      this.attachAbort(active, () => {
        this.settle(active)
        reject(new Error('question canceled'))
      })
      this.active = active
      const responder: PendingResponder = {
        kind: 'question',
        approve: () => undefined,
        answer: (answers) => {
          this.resolveQuestion(answers)
        },
        cancel: () => this.cancelPending(),
      }
      try {
        hooks.onPending(pending, responder)
      } catch (error) {
        this.active = undefined
        this.removeAbort(active)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private attachAbort(active: ActivePending, onAbort: () => void): void {
    if (active.signal === undefined) return
    if (active.signal.aborted) {
      queueMicrotask(onAbort)
      return
    }
    active.abort = onAbort
    active.signal.addEventListener('abort', onAbort, { once: true })
  }

  private removeAbort(active: ActivePending): void {
    if (active.signal !== undefined && active.abort !== undefined) {
      active.signal.removeEventListener('abort', active.abort)
    }
  }

  private settle(active: ActivePending): void {
    if (this.active !== active) return
    this.active = undefined
    this.removeAbort(active)
    this.hooks?.onSettled(active.requestId)
  }
}
