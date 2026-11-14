# 02 — Execution, sessions, persistence

## 1. Task lifecycle

```ts
type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted'
```

```text
queued ──► running ──► succeeded
   │          ├──────► failed
   │          ├──────► canceled
   │          └──────► waiting ──► running
   └──────────────────► canceled

running / waiting ──(DSH restart)──► interrupted
```

- `waiting` means the task is blocked on a pending approval or question. The invariant is
  `status === 'waiting'` ⇔ `pending` is present. `pending.kind` tells the caller which
  tool to use.
- `interrupted` is terminal. A `running` or `waiting` task found at startup becomes
  `interrupted`; it is not auto-retried. A `queued` task is re-queued.
- `succeeded` means the turn ended without an error. If no final assistant text exists,
  the task still succeeds but the content says "Task completed without a final message";
  the trace is the fallback.

## 2. Submit and queue

`dsh_task_submit`:

1. Validates auth, `cwd`, `sessionId` shape, and `sessionMode`.
2. Persists a `TaskRecord` with status `queued` and returns `taskId` immediately.
3. Does **not** allocate or hold a session.
4. Enqueues the task. A worker starts it as soon as a concurrency slot and its session/key
   lock are available. There is no timer and no delayed start.

Queue behavior:

- `maxConcurrent` bounds running tasks globally.
- Tasks sharing a pool key or an explicit `sessionId` are serialized.
- `maxQueue` bounds queued tasks. A submit beyond the bound fails with `busy`.
- `TaskState.queuePosition` is the current 1-based position while queued.
- `TaskState.blockedBy` is the `taskId` currently holding the session/key lock, when
  known. It tells the caller why the task has not started.
- A queued task does not reserve a session. The session is chosen at start.

### New run while another task is waiting

A new `dsh_task_submit` or `dsh_agent_run` on the same session/key is **queued**, not
rejected with `session_busy`. It reports `blockedBy` and `queuePosition`.

- If the blocking task is waiting for approval/question, the new task waits behind it.
- The caller can cancel the blocking task, cancel the queued task, or wait.
- To run in parallel in the same workspace, the caller must use
  `sessionMode: 'fresh'` or a different `cwd` / `preset` / `permissionPreset` / `model`.
- An explicit `sessionId` always serializes behind that session; there is no parallel
  execution on one session.

## 3. Session allocation

A worker allocates a session when the task actually starts.

### 3.1 With `sessionId`

Resolve in order:

1. The plugin's live pool.
2. `ctx.agents.get(sessionId)` for a UI-opened or otherwise live session.
3. `ctx.agents.resume({ resumeSessionId })` from DSH persistence.

If all three miss, fail with `session_not_found`. If the requested `cwd` differs from the
session header's `cwd` (after `realpath`), fail with `cwd_mismatch`. The hint includes the
session's cwd.

When the plugin resumed the session itself, it owns the handle: flush and dispose it when
the task ends. A live session owned by the UI/another plugin is not disposed.

### 3.2 Without `sessionId`

Use the pool key:

```text
cwd (realpath) + preset + permissionPreset + provider + model + reasoningEffort
```

- `sessionMode: 'reuse'` (default): use an idle pooled session for the key, or create one.
- `sessionMode: 'fresh'`: create a new session for this task. It is pooled under a unique
  key or released after the task; it never reuses an existing conversation.

Configuration-level `agent.preset` / `provider` / `model` are the defaults. Per-task
overrides are an extension after the core release.

### 3.3 Session pool

- Entry: `{ sessionId, handle, key, lastUsed, refs }`.
- LRU eviction only when `refs === 0`. Dispose flushes the session first.
- `agent.maxAgents` bounds pooled sessions.
- `agent.idleTtlMs` releases idle sessions.
- A session lock is independent of the pool key. A task holding a session holds that
  lock until it finishes, cancels, or is interrupted. This prevents two tasks from
  driving the same session under different keys.
- On plugin unload: stop accepting tasks, cancel active tasks or wait for them, close
  every transport, dispose pooled agents, close the HTTP server.

## 4. Execution

1. Acquire the session/key lock.
2. Create or resume the agent with `provider` and `model`. If neither config nor
   `agentDefaultModel.currentSelection()` provides a model, fail with
   `agent_unavailable`; do not start a turn that will fail empty.
3. In `setup`, mount `agent.preset` via the agent-preset registry and register the
   interaction answerers (see `04-interactions.md`).
4. Build the prompt:

   ```text
   You are the executing agent. Another agent delegated this task to you with context.
   You own the implementation and verification.

   Task:
   <task>

   Context:
   <context>

   When done, reply with your final answer or report. It can be a single sentence or a
   complete document. If the report is long, write it to a file and include the path and a
   short conclusion. Do not wrap the final answer in JSON.
   ```

5. Send one follow-up message with the producer-owned source kind
   `plugin:dsh-task-delegation`.
6. Wait for the agent to become idle, bounded by the task timeout.
7. Extract the final answer and progress from the task's session-log range.
8. Persist the result and release the lease.

## 5. Final answer

The final answer is the **last assistant message with non-empty text** after the task's
baseline sequence. It is returned verbatim:

- Markdown, code blocks, line breaks, and Unicode are preserved.
- It may be a single sentence or a complete document.
- It is placed in `content` as one text block. It is never wrapped in JSON.
- It is persisted in the task record so `dsh_task_get` can return it after a restart.
- If no assistant text exists, `content` says so and `dsh_task_trace` is the fallback.

There is no `changes/verification/leftovers` parser and no required final JSON line. The
old one-line summary instruction is removed; it distorts formal reports and is a
code-facing design.

If the final answer exceeds `agent.maxAnswerBytes` (default 64 KiB), the returned content
is a prefix with an explicit `[truncated]` marker. The full message is available through
`dsh_task_trace`. The prompt also encourages writing very long reports to a file and
returning the path plus a short conclusion.

## 6. Progress

While running, the plugin maintains one bounded string derived from the session event
stream:

- `assistant: <first ~160 chars of the last assistant text>`
- `tool <name>: <first ~120 chars of the arguments>`
- `thinking` (only if a reasoning block is the latest event)

`TaskState.progress` is that string. It is a hint, not a contract. It is persisted on
state changes and at terminal, so an `interrupted` task keeps its last known progress.
The full event history is never duplicated into `TaskState`.

## 7. Trace

`dsh_task_trace` returns a **readable transcript** for one task. It is built from the
session log range:

- `fromSeq`: recorded immediately before the follow-up is sent.
- `toSeq`: recorded when the task becomes terminal.
- The range scopes the trace to this task even when the session is reused by later tasks.

Sources:

- Running task: the live session log.
- Completed task: DSH session persistence, using `sessionId` and the stored range.
- If the session is gone or compacted beyond the range, return a `trace_unavailable`
  tool error whose message states `session_gone` or `compacted`; do not pretend the trace
  is complete.

Transcript format (in `content`):

```text
[12] assistant
...

[13] tool bash
args: ...

[14] tool result (error=false)
...
```

- `include` selects `messages`, `reasoning`, `toolCalls`, `toolResults`, `interactions`.
- `reasoning` is opt-in and appears only when DSH persisted a reasoning block.
- Pagination uses `afterSeq` and `limit`; `structuredContent` carries `nextAfterSeq`,
  `hasMore`, and `truncated` only.
- Each event is capped (default 8 KiB); a truncated event is marked `[truncated]`.
- Raw DSH JSON is never exposed.

## 8. Cancellation

`dsh_task_cancel` is idempotent.

| State | Behavior |
|---|---|
| `queued` | Remove from queue; status `canceled`. |
| `running` | Call `agent.cancel()`; wait for the configured grace period; if it does not converge, dispose the session; status `canceled`. |
| `waiting` | Resolve the pending interaction as `cancelled`, clear it, cancel the turn; status `canceled`. |
| terminal | Return the current state; the content says it is already finished; not an error. |

Race with approve/answer: the first terminal transition wins. The loser receives
`task_terminal` or `interaction_expired` with the current state and does not change it.
The cancel response's `content` says whether the task was canceled or was already
finished.

## 9. Persistence and recovery

Each task is a JSON file:

```text
$DSH_HOME/storages/dsh-task-delegation/tasks/<taskId>.json
```

Writes are atomic (temporary file + rename). The task record contains:

```ts
interface TaskRecord {
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
  decisions?: { requestId: string; kind: 'approval' | 'question'; decision: string; at: string }[]
}
```

Recovery at startup:

- `queued`: re-queue.
- `running` / `waiting`: mark `interrupted`, clear `pending`. Pending interactions cannot
  survive a process restart.
- Prune tasks older than `tasks.ttlMs` and beyond `tasks.maxRetained`.
- The full transcript is not stored in the task record; the trace reads DSH persistence.

Retention defaults: 7 days, 1,000 tasks. A pruned task returns `task_not_found`.

## 10. Failure modes

| Condition | Result |
|---|---|
| No model/preset | `failed` with `agent_unavailable` |
| `cwd` missing | `failed` with `cwd_not_found` |
| `cwd` outside roots | `failed` with `cwd_forbidden` |
| Session not found | `failed` with `session_not_found` |
| Session cwd mismatch | `failed` with `cwd_mismatch` |
| Turn ends with error | `failed` with `agent_failed` and the error message |
| Task timeout | `failed` with `timeout`; the agent is canceled |
| Approval needed but mode cannot ask | `failed` with `approval_required` |
| Question needed but mode cannot ask | `failed` with `question_unavailable` |
| Approval/question TTL | `failed` with `approval_timeout` / `question_timeout` |
| Plugin/DSH restart | `interrupted` |
| Queue full | Submit fails with `busy`; no task is created |
