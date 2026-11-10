# 04 — Approvals and user questions

## 1. Why this is core

A task that needs approval or an answer is not an edge case; it is a normal part of
driving a coding agent. The core release therefore includes the `waiting` state, the
pending payload, and the `dsh_task_approve` / `dsh_task_answer` tools. There is no
"v0.1 without interactions".

The caller must be able to answer:

- Is DSH blocked?
- On what kind of request?
- Which `requestId` do I use?
- Which tool do I call?
- What happens if I am wrong, late, or duplicate the call?

## 2. DSH mechanisms

DSH exposes two Agent-scoped answerer waterfalls:

- `approval/request` — one-shot approval for a sensitive tool action.
- `user-questions/request` — a tool call paused for a human answer.

The plugin registers listeners in the agent's `setup` scope. For each session it keeps a
`SessionInteractions` bridge:

```ts
interface SessionInteractions {
  sessionId: string
  currentTaskId?: string
  pending?: {
    taskId: string
    requestId: string
    kind: 'approval' | 'question'
    resolve: (outcome: unknown) => void
    reject: (error: Error) => void
    expiresAt: number
  }
}
```

- When a request arrives and a task is active on that session, the bridge creates a
  pending record, transitions the task to `waiting`, and waits for a decision.
- When no task is active (for example, a human is driving the session in the DSH UI), the
  plugin calls `next()` so the host/UI answerer can handle it. If no answerer exists, the
  request fails closed.
- A session is serialized: at most one task drives it at a time. This is what makes
  routing an approval to the right task safe.

### Live sessions

For an agent created or resumed by the plugin, `setup` registers the listeners. For a
live session owned by the UI or another plugin, the plugin may be able to register on the
agent's scoped context when it takes the lease. If it cannot, approvals/questions from
that session are delegated with `next()` or fail closed; the task is not allowed to hang
silently.

## 3. Pending lifecycle

```text
request arrives
   │
   ▼
pending created (status: waiting)
   │
   ├── dsh_task_approve / dsh_task_answer ──► resolve ──► running
   ├── dsh_task_cancel ─────────────────────► resolve(cancelled) ──► canceled
   ├── TTL expires ─────────────────────────► resolve(cancelled) ──► failed(timeout)
   └── DSH restart ─────────────────────────► interrupted, pending cleared
```

- `requestId` is unique per request. It is the idempotency key for decisions and prevents
  a stale approval from affecting a later request.
- `expiresAt` is an ISO timestamp. The default TTL is `interactions.approvalTimeoutMs` /
  `interactions.questionTimeoutMs` (5 minutes).
- `pending` is process-local. It is persisted only as a snapshot for diagnostics; after a
  restart the task becomes `interrupted` and the pending is invalid.

## 4. Policy modes

`interactions.mode`:

| Mode | Behavior | Use |
|---|---|---|
| `remote` | The plugin is the terminal answerer; the MCP caller decides via approve/answer | Default on loopback; explicit opt-in for non-loopback |
| `deny` | Fail closed immediately; the task reports `approval_required` / `question_unavailable` | Strict/unattended deployments |
| `host` | Delegate with `next()` to the DSH UI/host answerer | Experimental; requires verification that the host answers plugin-owned sessions |

### Defaults

- Loopback bind: `remote`.
- Non-loopback bind: `remote` is **not** the default; the operator must set it
  explicitly. `deny` is the safe default there.
- `host` is never the default in the core release.

### Trust model

The bearer token is the trust boundary. A caller with the token can already ask DSH to
execute code. Allowing that caller to approve a one-shot escalation is a deliberate
deployment choice, not a hidden default:

- The decision is explicit: `allow-once` or `reject`.
- A grant applies only to the current `requestId`.
- Every decision is audited.
- `deny` is available for operators who do not want the caller to approve anything.
- Non-loopback deployments must opt in to `remote`.

## 5. Decision tools

### 5.1 `dsh_task_approve`

```ts
{ taskId, requestId, decision: 'allow-once' | 'reject' }
```

- Only valid when `status === 'waiting'` and `pending.kind === 'approval'`.
- `allow-once` maps to DSH's `allowed-once` outcome; `reject` maps to `rejected`.
- The first decision wins. The pending is cleared and the task returns to `running`.
- A repeated call with the same `requestId` and the same decision is idempotent: success,
  `content` says it was already recorded.
- A different decision after resolution returns `interaction_expired`; the outcome is not
  changed.
- If the task is not waiting, return `task_not_waiting` with the current state.
- If the task is terminal, return `task_terminal` with the current state.

### 5.2 `dsh_task_answer`

```ts
{
  taskId
  requestId
  answers: { questionId: string; selected: string[]; custom?: string }[]
}
```

- Only valid for `pending.kind === 'question'`.
- One answer item per pending question. Missing/extra IDs or unknown option labels →
  `answer_invalid`; the pending remains valid and can be retried.
- `custom` follows DSH's rules: it may replace a single-select choice or supplement a
  multi-select selection.
- A repeated identical answer is idempotent; a conflicting answer after resolution is
  `interaction_expired`.

## 6. Cancel and new tasks

- `dsh_task_cancel` on a waiting task resolves the pending as `cancelled` and cancels the
  turn. The answerer receives the cancellation and the agent sees the tool call canceled.
- A new `dsh_task_submit` / `dsh_agent_run` on the same session/key is queued behind the
  waiting task (`blockedBy`). It does not cancel or replace the pending interaction.
- To run something else in parallel, use `sessionMode: 'fresh'` or a different
  `cwd`/`preset`/`model`.

## 7. Race and invalid-command matrix

| Situation | Result | Task state |
|---|---|---|
| approve on question | `interaction_kind_mismatch`, expected `answer` | unchanged |
| answer on approval | `interaction_kind_mismatch`, expected `approve` | unchanged |
| approve/answer with wrong `requestId` | `interaction_not_found` | unchanged |
| approve/answer after TTL | `interaction_expired` | unchanged (may already be failed) |
| approve/answer after cancel | `task_terminal` / `interaction_expired` | unchanged |
| approve/answer after success/failure with a new requestId | `task_terminal` | unchanged |
| duplicate same decision (even after the task finishes) | success, "already recorded" | unchanged |
| duplicate conflicting decision | `interaction_expired` | unchanged |
| cancel while waiting | success; pending resolved canceled | `canceled` |
| new run while waiting | success; new task queued | `waiting` stays |
| approve and cancel race | first terminal transition wins; loser gets a typed error | one outcome |
| DSH restart while waiting | task becomes `interrupted`; pending cleared | `interrupted` |

**Rule: an invalid command never mutates the task or the pending interaction.** Only a
valid decision, cancel, timeout, or process restart changes the state.

## 8. Answer validation

Validation happens before the DSH answerer is resolved:

- The task exists and is `waiting`.
- `pending.kind === 'question'`.
- `requestId` matches the current pending.
- Each pending question has exactly one answer item.
- No unknown question IDs.
- `selected` labels exist in the question options; `custom` is allowed where the question
  permits it.

Invalid input returns `answer_invalid` with a precise message and the pending state. The
caller can correct and retry without losing the task.

## 9. Audit and privacy

Log and persist, per decision:

- `taskId`, `requestId`, `kind`
- `toolName` or question ids
- decision (`allow-once` / `reject`) or answer ids
- timestamp
- outcome

Do not log prompts, full tool arguments, or file contents. The decision audit is for
accountability, not transcript storage. The trace is the place for detailed history, and
it is token-protected.

## 10. Host mode (experimental)

`host` delegates with `next()` to whatever answerer is composed for the agent (for
example, a DSH UI panel). It is experimental because:

- The plugin's agents are owned by the plugin; a UI answerer may not claim them.
- The DSH UI may only answer sessions it owns.
- A missing host answerer must fail closed, not hang.

If a deployment wants human-in-the-loop approval in the DSH UI, it should be tested
against the actual session ownership path before `host` is documented as supported.
