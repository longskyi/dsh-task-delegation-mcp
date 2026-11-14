# 03 — MCP tools and result shape

## 1. Result envelope

Every tool returns:

```ts
{
  content: ContentBlock[]        // what the agent reads
  structuredContent?: object     // what the next tool call needs
  isError?: boolean
}
```

- `content` is the primary, agent-facing channel. For a successful task it is the DSH
  agent's final answer, verbatim. For a waiting/queued/running task it is a short,
  actionable status line. For an error it is a short, actionable recovery hint.
- `structuredContent` is minimal machine state. It never duplicates the final answer.
- `isError: true` is for failed operations, not for normal `queued` / `running` /
  `waiting` states.
- Domain errors are returned as tool errors with `content` + `structuredContent`; do not
  throw raw exceptions or return only a JSON-RPC error.

## 2. Common types

```ts
type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'interrupted'

interface TaskState {
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

interface TaskError {
  code: string
  message: string
}

type Pending =
  | {
      kind: 'approval'
      requestId: string
      toolName: string
      reason?: string
      expiresAt: string
    }
  | {
      kind: 'question'
      requestId: string
      questions: {
        id: string
        question: string
        options?: { label: string; description?: string }[]
        multiSelect?: boolean
      }[]
      expiresAt: string
    }

interface TaskSummary {
  taskId: string
  preview: string          // first ~120 characters of the task
  status: TaskStatus
  cwd: string
  createdAt: string
  pendingKind?: 'approval' | 'question'
  errorCode?: string
}

interface TraceState {
  taskId: string
  nextAfterSeq?: number
  hasMore: boolean
  truncated: boolean
}

interface ToolErrorState {
  error: {
    code: string
    message: string
    expected?: string
    actual?: string
  }
  state?: TaskState
}
```

`TaskState` is deliberately small. Everything else belongs to the final answer
(`content`), `dsh_task_list` (`TaskSummary`), or `dsh_task_trace` (readable transcript).

## 3. Tool catalog

| Tool | Kind | Use when |
|---|---|---|
| `dsh_task_submit` | action | Enqueue a task; returns immediately |
| `dsh_task_get` | read | Read the current state without waiting |
| `dsh_task_wait` | read | Wait until terminal / `waiting` / timeout |
| `dsh_agent_run` | convenience | Submit and wait in one call; always returns the taskId |
| `dsh_task_cancel` | action | Cancel a queued/running task, or resolve a pending interaction as canceled |
| `dsh_task_list` | read | Discover recent tasks |
| `dsh_task_approve` | action | Decide a `waiting` approval |
| `dsh_task_answer` | action | Answer a `waiting` question |
| `dsh_task_trace` | read | Read a task's execution transcript in pages |

Extension tools (not in the core release): `dsh_capabilities`, `dsh_session_list`,
`dsh_session_attach`, `dsh_session_rename`.

## 4. Tool definitions

### 4.1 `dsh_task_submit`

Description: "Enqueue a task for DSH and return its taskId immediately."

```ts
{
  task: string
  context?: string
  cwd?: string
  sessionId?: string
  sessionMode?: 'reuse' | 'fresh'   // default: reuse
  permissionPreset?: string          // e.g. "auto"; operator allowlist required
  title?: string
}
```

- `cwd` defaults to the plugin process cwd; it is canonicalized with `realpath`.
- `sessionId` continues an existing session; `sessionMode` is ignored when it is set.
- `title` names the DSH session for the UI.
- `permissionPreset` is applied before the first turn. It must appear in the
  operator-controlled `agent.allowedPermissionPresets`; otherwise the call fails with
  `permission_denied`. An unknown/unavailable preset fails the task with
  `permission_unavailable`.
- `auto` requires the Auto review layer and runs with Full access plus per-call review.
  Auto-review denials are never routed to the remote caller.
- Returns `content`: `Task <taskId> queued.` (or `started` if a worker won immediately) and
  `structuredContent`: `TaskState`.
- Queue full → tool error `busy`, no task created.

### 4.2 `dsh_task_get`

Description: "Read a task's current state without waiting."

```ts
{ taskId: string }
```

Returns the appropriate `content` for the current state (see §5) and `TaskState`.
This is safe to call repeatedly; it never blocks.

### 4.3 `dsh_task_wait`

Description: "Wait until a task finishes or needs approval/answer, or the timeout expires. A timeout or a canceled MCP request only ends the wait; the task keeps running."

```ts
{
  taskId: string
  timeoutMs?: number   // default: agent.defaultSyncWaitMs; capped by interactions.maxWaitMs (default 1_800_000)
}
```

- Returns early on `succeeded`, `failed`, `canceled`, `interrupted`, or `waiting`.
- On timeout returns the current `running`/`queued` state; it is not an error.
- Canceling the MCP request ends only the wait; it never cancels the task. The content
  says the task continues. Use `dsh_task_cancel` for an explicit stop.
- `content` on timeout: `Task <taskId> is still running: <progress>. Wait timed out after
  <effective> ms. Call dsh_task_wait again.`
- When the requested wait exceeded `interactions.maxWaitMs`, content also names the
  requested value and the cap, so a shortened wait is never silent.

### 4.4 `dsh_agent_run`

Description: "Submit a task and wait for it; convenience for one-shot delegation. A wait timeout or a canceled MCP request does not cancel the task; use dsh_task_cancel for that."

```ts
{
  task: string
  context?: string
  cwd?: string
  sessionId?: string
  sessionMode?: 'reuse' | 'fresh'
  permissionPreset?: string
  title?: string
  timeoutMs?: number
}
```

- Internally `dsh_task_submit` + `dsh_task_wait`.
- When the call returns, it includes the `taskId`, even when the wait times out.
- It is not a second execution path and creates no extra task beyond the one submitted.
- If the MCP request is aborted, no result is delivered but the task keeps running; recover
  its id with `dsh_task_list` or use `dsh_task_submit` first when long waits are expected.
- A wait timeout or MCP abort never cancels the task; use `dsh_task_cancel` for that.
- Do not call it again to continue the same task; use `dsh_task_get` / `dsh_task_wait`
  with the returned `taskId`.

### 4.5 `dsh_task_cancel`

Description: "Cancel a queued or running task; a pending approval/question is canceled too."

```ts
{ taskId: string }
```

- Idempotent. Canceling an already terminal task returns its current state and
  `content`: `Task <taskId> is already <status>; nothing to cancel.`
- Canceling a `waiting` task resolves the pending interaction as canceled, then cancels
  the turn.
- Returns `content`: `Task <taskId> canceled.` and `TaskState`.

### 4.6 `dsh_task_list`

Description: "List recent tasks; returns summaries only."

```ts
{
  status?: TaskStatus
  cwd?: string
  limit?: number   // default 20, max 100
}
```

- `content` is a readable list, newest first:

  ```text
  t_123  succeeded  ~30s ago  Fix failing tests
  t_124  waiting    ~1m ago   Refactor auth (approval)
  ```

- `structuredContent`: `{ taskIds: string[] }` — only IDs, no duplicated summaries.
- `preview` is the first ~120 characters of the task.
- Does not include the final answer; use `dsh_task_get` for that.

### 4.7 `dsh_task_approve`

Description: "Approve or reject the pending approval on a waiting task."

```ts
{
  taskId: string
  requestId: string
  decision: 'allow-once' | 'reject'
}
```

- Success `content`: `Approval recorded (allow-once); task <taskId> resumed.`
- Success `structuredContent`: `TaskState`.
- A repeated call with the same `requestId` and the same decision is idempotent: success,
  content says it was already recorded.
- A different decision after resolution, an expired request, or a canceled task returns
  a tool error (`interaction_expired` / `task_terminal`); the pending is never changed.

### 4.8 `dsh_task_answer`

Description: "Answer the pending questions on a waiting task."

```ts
{
  taskId: string
  requestId: string
  answers: {
    questionId: string
    selected: string[]
    custom?: string
  }[]
}
```

- One `answers[]` item per pending question.
- `selected` uses option labels; `custom` may supplement or replace per DSH's rules.
- Invalid shape or missing question → tool error `answer_invalid`; the pending remains.
- Success `content`: `Answer recorded; task <taskId> resumed.`
- Success `structuredContent`: `TaskState`.

### 4.9 `dsh_task_trace`

Description: "Read a task's execution transcript in pages."

```ts
{
  taskId: string
  afterSeq?: number
  limit?: number       // default 50, max 200
  include?: (
    | 'messages'
    | 'reasoning'
    | 'toolCalls'
    | 'toolResults'
    | 'interactions'
  )[]
  maxBytes?: number    // default 64 KiB, max 256 KiB
}
```

- `content` is a readable transcript (see §7). It is not raw DSH JSON.
- `structuredContent`: `TraceState` only — pagination metadata, not the events.
- Default `include` is all except `reasoning`. `reasoning` is opt-in and exists only when
  DSH persisted a reasoning block.
- `afterSeq` is exclusive. `nextAfterSeq` continues the page.
- Per-event truncation is marked `[truncated]`; `TraceState.truncated` is true if any
  event or the page budget truncated content.
- If the task has not started, return `trace_unavailable` with a hint to wait.
- If the session is gone or compacted, return `trace_unavailable` with
  `unavailableReason` in the content and the current `TaskState` if available.

## 5. Content per state

### 5.1 Succeeded

`content` is the final answer, exactly as the DSH agent wrote it:

```ts
content: [{ type: 'text', text: finalAnswer }]
structuredContent: { taskId, status: 'succeeded', sessionId }
```

Nothing is appended. Do not repeat the answer in `structuredContent`.

### 5.2 Waiting

```text
Task t_123 is waiting for approval (requestId a_1): bash — command needs approval.
Call dsh_task_approve with decision "allow-once" or "reject".
```

```ts
structuredContent: {
  taskId: 't_123',
  status: 'waiting',
  sessionId: 's_456',
  pending: { kind: 'approval', requestId: 'a_1', toolName: 'bash', reason: '...', expiresAt: '...' }
}
```

For a question:

```text
Task t_123 is waiting for an answer (requestId q_1, 2 questions).
Call dsh_task_answer with one answers[] item per question.
```

### 5.3 Queued

```text
Task t_124 is queued behind t_123 (position 2). Call dsh_task_wait or dsh_task_get.
```

```ts
structuredContent: { taskId: 't_124', status: 'queued', queuePosition: 2, blockedBy: 't_123' }
```

### 5.4 Running (wait timeout / get)

```text
Task t_123 is still running: tool bash — npm test. Call dsh_task_wait again.
```

```ts
structuredContent: { taskId: 't_123', status: 'running', sessionId: 's_456', progress: 'tool bash: npm test' }
```

### 5.5 Failed / interrupted

```text
Task t_123 failed: timeout after 1800000 ms.
Call dsh_task_trace for the execution history.
```

```ts
structuredContent: {
  taskId: 't_123',
  status: 'failed',
  sessionId: 's_456',
  error: { code: 'timeout', message: 'timeout after 1800000 ms' }
}
```

### 5.6 Canceled

```text
Task t_123 canceled.
```

```ts
structuredContent: { taskId: 't_123', status: 'canceled', sessionId: 's_456' }
```

## 6. Errors and next-step hints

### 6.1 Rules

- Set `isError: true` only when the requested operation failed.
- `queued`, `running`, and `waiting` are normal states; never errors.
- A wrong, stale, or duplicate command must **not** mutate the task. The pending stays
  valid, or the terminal state is returned unchanged.
- Put the recovery hint in `content`; put `error.code`, `expected`, `actual`, and the
  current `state` in `structuredContent`.
- One sentence is enough. Name the exact tool and IDs. Do not write a generic "try again".

### 6.2 Error result shape

```ts
{
  isError: true,
  content: [{ type: 'text', text: '...' }],
  structuredContent: {
    error: { code, message, expected?, actual? },
    state?: TaskState
  }
}
```

### 6.3 Error catalog

| Code | When | `content` hint |
|---|---|---|
| `invalid_request` | Schema/argument failure | Name the bad parameter and expected shape. |
| `task_not_found` | Unknown `taskId` | "Check the id or call `dsh_task_list`." |
| `task_not_waiting` | approve/answer on a non-waiting task | "Task is `<status>`. Call `dsh_task_get`." |
| `task_terminal` | approve/answer after finish | "Task already `<status>`. Call `dsh_task_get` for the result." |
| `interaction_not_found` | Unknown `requestId` for this task | "No pending request with that id. Call `dsh_task_get`." |
| `interaction_kind_mismatch` | approve on question, answer on approval | "This task is waiting for an `<expected>`. Call `dsh_task_<expected>` with requestId..." |
| `interaction_expired` | TTL elapsed / canceled / already resolved differently | "The request expired or was resolved. Call `dsh_task_get`; don't reuse this requestId." |
| `answer_invalid` | Missing/extra question or bad option | "answers must include one item per question; missing `<id>`. The pending request is still valid." |
| `busy` | Queue full / concurrency limit | "Queue is full. Wait for a running task or cancel a queued task with `dsh_task_cancel`." |
| `cwd_not_found` | `cwd` missing | "Pass an existing absolute directory." |
| `cwd_forbidden` | outside `workspaceRoots` | "Use a cwd under an allowed workspace root." |
| `cwd_mismatch` | session belongs to another cwd | "Session belongs to `<cwd>`. Pass that cwd or omit `sessionId`." |
| `session_not_found` | no pooled/live/persisted session | "Omit `sessionId` to create/reuse a session, or check the id." |
| `agent_unavailable` | no model/preset or creation failed | "Configure `agent.provider`/`agent.model` or DSH's default model, then retry." |
| `permission_denied` | caller-requested preset is not in `agent.allowedPermissionPresets` | "Omit `permissionPreset` or use an operator-allowed preset." |
| `permission_unavailable` | preset service/preset unavailable (e.g. `auto` without Auto review) | "Enable the DSH permission preset (and Auto review for `auto`), or omit `permissionPreset`." |
| `approval_required` | approval needed but the mode cannot ask (`deny`, or `host` with no answerer) | "Approval is unavailable in the current host mode. Ask the operator to enable remote approval; this task cannot proceed." |
| `question_unavailable` | question needed but the mode cannot ask | "User questions are unavailable in the current host mode. Ask the operator; this task cannot proceed." |
| `approval_timeout` / `question_timeout` | pending TTL expired | "The request timed out. Call `dsh_task_get` for the final state." |
| `trace_unavailable` | session gone/compacted/not started | "Trace is unavailable (<reason>). Call `dsh_task_get` for the result, or `dsh_task_wait` if it is still running." |
| `internal` | unexpected server failure | "Retry once; if it persists, inspect the DSH log." |

### 6.4 Examples

Wrong kind:

```ts
{
  isError: true,
  content: [{
    type: 'text',
    text: 'Task t_123 is waiting for an answer, not an approval. ' +
          'Call dsh_task_answer with taskId="t_123", requestId="q_789".'
  }],
  structuredContent: {
    error: {
      code: 'interaction_kind_mismatch',
      message: 'expected answer, got approve',
      expected: 'answer',
      actual: 'approve'
    },
    state: { taskId: 't_123', status: 'waiting', pending: { kind: 'question', requestId: 'q_789', /* ... */ } }
  }
}
```

Expired:

```ts
{
  isError: true,
  content: [{
    type: 'text',
    text: 'The approval request a_1 expired or was canceled. ' +
          'Call dsh_task_get to refresh the task; do not reuse this requestId.'
  }],
  structuredContent: {
    error: { code: 'interaction_expired', message: 'request a_1 is no longer pending' },
    state: { taskId: 't_123', status: 'running' }
  }
}
```

## 7. Trace transcript format

`dsh_task_trace` `content` is human/agent-readable:

```text
[12] assistant
I checked the failing test and found the fixture path is wrong.

[13] tool bash
args: {"command":"npm test -- --runInBand","description":"Run tests"}

[14] tool result (error=false)
PASS packages/foo/test/a.test.ts

[15] reasoning
The fixture path is relative to the package root, so ...
```

- `[seq]` is the session event sequence; it does not need to be contiguous.
- `reasoning` appears only when `include` asks for it and DSH persisted it.
- `interactions` events show approval/question asks and decisions.
- Truncated events end with `[truncated]`.
- `structuredContent` is only `TraceState`; do not duplicate the transcript there.

## 8. Field and naming conventions

- `timeoutMs` everywhere; no `waitMs`, no `timeout` seconds.
- `taskId`, `sessionId`, `requestId`; camelCase.
- `sessionMode: 'reuse' | 'fresh'`.
- `decision: 'allow-once' | 'reject'`.
- `answers: [{ questionId, selected, custom? }]`.
- `afterSeq`, `limit`, `include`, `nextAfterSeq`.
- `queuePosition`, `blockedBy`.
- `pending.kind: 'approval' | 'question'`.
- Status values are lowercase verbs/adjectives; `waiting` covers both approval and
  question so the status alone never lies about which tool to call.

## 9. Implementation notes

- Register tools with `registerTool` and a zod schema; put defaults and ranges on the
  parameter.
- `content` is the model-facing channel. `structuredContent` is for IDs/state. If an
  error hint exists only in `structuredContent`, many models will never see it — put it
  in `content`.
- Do not return the final answer in `structuredContent`; it would be duplicated and
  increase tokens on every call.
- Do not throw raw errors from tool handlers; map them to `{ isError: true, content,
  structuredContent }`.
- The MCP SDK validates `inputSchema` before the handler. A malformed argument shape is
  therefore rejected by the protocol (`-32602 Input validation error`) rather than the
  domain envelope; handler-level `invalid_request` covers values that pass the schema but
  fail manager checks. This is an SDK boundary, not an unmapped exception.
- If the MCP SDK validates `structuredContent` against an `outputSchema`, define the
  success shape as `TaskState` and return error shapes with `isError: true` (verify the
  SDK's error validation behavior; otherwise omit `outputSchema` and document the shape).
- Keep tool descriptions one sentence; put parameter rules on the parameter.
