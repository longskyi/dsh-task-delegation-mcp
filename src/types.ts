/** Public task state shared by the MCP tools and the task manager. */

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted'

export type PendingKind = 'approval' | 'question'

export interface ApprovalPending {
  kind: 'approval'
  requestId: string
  toolName: string
  reason?: string
  expiresAt: string
}

export interface QuestionOption {
  label: string
  description?: string
}

export interface QuestionItem {
  id: string
  question: string
  options?: QuestionOption[]
  multiSelect?: boolean
}

export interface QuestionPending {
  kind: 'question'
  requestId: string
  questions: QuestionItem[]
  expiresAt: string
}

export type Pending = ApprovalPending | QuestionPending

export interface TaskError {
  code: string
  message: string
}

export interface TaskState {
  taskId: string
  status: TaskStatus
  sessionId?: string
  permissionPreset?: string
  queuePosition?: number
  blockedBy?: string
  progress?: string
  pending?: Pending
  error?: TaskError
}

export interface TaskSummary {
  taskId: string
  preview: string
  status: TaskStatus
  cwd: string
  createdAt: string
  pendingKind?: PendingKind
  errorCode?: string
}

export interface TraceState {
  taskId: string
  nextAfterSeq?: number
  hasMore: boolean
  truncated: boolean
}

export type TraceInclude = 'messages' | 'reasoning' | 'toolCalls' | 'toolResults' | 'interactions'

/** Persisted task record. Runtime-only fields live in the manager. */
export interface DecisionAudit {
  requestId: string
  kind: PendingKind
  decision: string
  at: string
}

export interface TaskRecord {
  taskId: string
  status: TaskStatus
  task: string
  context: string
  cwd: string
  sessionMode: 'reuse' | 'fresh'
  preset: string
  permissionPreset?: string
  provider?: string
  model?: string
  sessionId?: string
  title?: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  progress?: string
  pending?: Pending
  error?: TaskError
  answer?: string
  fromSeq?: number
  toSeq?: number
  decisions?: DecisionAudit[]
}

/** Why and how long a wait call actually waited. */
export interface WaitInfo {
  timedOut: boolean
  /** The caller stopped waiting; the task itself was not canceled. */
  aborted?: boolean
  requestedTimeoutMs: number
  effectiveTimeoutMs: number
  capped: boolean
  maxWaitMs: number
}

export function isTerminal(status: TaskStatus): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'interrupted'
}

export function isSettled(status: TaskStatus): boolean {
  return isTerminal(status) || status === 'waiting'
}

export function toTaskState(
  record: TaskRecord,
  queue?: { queuePosition?: number; blockedBy?: string },
): TaskState {
  const state: TaskState = { taskId: record.taskId, status: record.status }
  if (record.sessionId !== undefined) state.sessionId = record.sessionId
  if (record.permissionPreset !== undefined) state.permissionPreset = record.permissionPreset
  if (queue?.queuePosition !== undefined) state.queuePosition = queue.queuePosition
  if (queue?.blockedBy !== undefined) state.blockedBy = queue.blockedBy
  if (record.progress !== undefined) state.progress = record.progress
  if (record.pending !== undefined) state.pending = record.pending
  if (record.error !== undefined) state.error = record.error
  return state
}

export function previewOf(task: string, max = 120): string {
  const clean = task.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}
