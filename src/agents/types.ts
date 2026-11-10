import type { Pending, TaskError, TaskRecord } from '../types.js'
import type { TraceEvent } from '../trace.js'

export interface AnswerItem {
  questionId: string
  selected: string[]
  custom?: string
}

export interface ApprovalResponder {
  approve(outcome: 'allowed-once' | 'rejected'): void
}

export interface QuestionResponder {
  answer(answers: readonly AnswerItem[]): void
}

export interface PendingResponder {
  kind: 'approval' | 'question'
  approve(outcome: 'allowed-once' | 'rejected'): void
  answer(answers: readonly AnswerItem[]): void
  cancel(): void
}

export interface RunHooks {
  /** Called once, before the follow-up is sent. Persist this before proceeding. */
  onSession(sessionId: string, fromSeq: number): Promise<void> | void
  onProgress(progress: string): void
  onPending(pending: Pending, responder: PendingResponder): void
  onSettled(requestId: string): void
  onUnavailable(kind: 'approval' | 'question', message: string): void
}

export type RunCancelReason = 'user' | 'timeout' | 'shutdown' | 'failure'

export interface RunResult {
  status: 'succeeded' | 'failed' | 'canceled'
  answer?: string
  error?: TaskError
  fromSeq: number
  toSeq: number
}

export interface AgentRun {
  readonly taskId: string
  readonly result: Promise<RunResult>
  cancel(reason: RunCancelReason): Promise<void>
  forceDispose(): Promise<void>
}

export type TraceRead =
  | { events: TraceEvent[]; toSeq: number }
  | { unavailable: 'not_started' | 'session_gone' | 'compacted' }

/** The execution seam. Unit tests use a fake implementation. */
export interface TaskAdapter {
  poolKey(record: TaskRecord): string
  start(record: TaskRecord, hooks: RunHooks): Promise<AgentRun>
  readTrace(record: TaskRecord, fromSeq: number): Promise<TraceRead>
  health(): { pooled: number; active: number }
  close(): Promise<void>
}
