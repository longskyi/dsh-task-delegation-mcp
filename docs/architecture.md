# Architecture

The authoritative behavior is the multi-file spec starting at
[spec/README.md](spec/README.md). This note maps that design to the source tree.

## Layers

```text
src/index.ts                Cordis plugin entry: name / inject / apply
src/runtime.ts              per-apply config, logger, version, start time
src/config.ts               full config defaults and validation
src/logger.ts               small structured logger

src/mcp/server.ts           one McpServer per Streamable HTTP session
src/mcp/http-server.ts      /healthz, auth, origin, body limit, transports
src/mcp/tools/tasks.ts      the nine core tools
src/mcp/format.ts           content/structuredContent and error hints

src/tasks/manager.ts        state machine, queue, locks, waiters, pending, timeout
src/tasks/store.ts          atomic per-task JSON persistence and pruning

src/agents/types.ts         execution adapter seam used by fake tests
src/agents/dsh-adapter.ts   DSH agents/sessions/presets/persistence adapter
src/agents/bridge.ts        approval and user-question waterfall bridge
src/trace.ts                pure readable-trace formatter

src/types.ts                TaskRecord / TaskState / Pending / TraceState
src/errors.ts               DomainError and stable error codes
```

## Request flow

```text
MCP client
  │ POST /mcp
  ▼
http-server ──► McpServer (one per transport session)
                    │ tools/call
                    ▼
              tasks.ts (thin validation/format layer)
                    │
                    ▼
              TaskManager
        ┌───────────┼────────────┐
        ▼           ▼            ▼
   TaskStore   queue/locks   DshTaskAdapter
                                   │
                     ┌─────────────┼──────────────┐
                     ▼             ▼              ▼
                ctx.agents   agentPresets   sessionPersistence
```

## Execution flow

1. `dsh_task_submit` validates `cwd`, creates a queued `TaskRecord`, persists it, and
   returns. No agent or session is allocated yet.
2. `TaskManager.pump()` starts a task when a global concurrency slot and its lock are
   free. The lock is the explicit session id, a fresh-task id, or the pool key.
3. The adapter allocates a session at start: reuse an idle pooled session, create one, or
   resolve an explicit session through the pool → live registry → persistence.
4. The adapter sends one follow-up message with source kind
   `plugin:dsh-task-delegation`, then waits for the agent to become idle.
5. The task's log range is `[fromSeq, toSeq)`. The last assistant text in that range is
   the final answer. A failed `turn/end` becomes `failed`.
6. The manager persists the result, releases the lock, and pumps the next queued task.

## Interactions

`SessionInteractionBridge` is registered on the agent-scoped context during `setup`.
It claims `approval/request` and `user-questions/request` only while a plugin task owns
the session. Otherwise it calls `next()` so the host/UI can answer.

- `remote`: create a pending request, transition to `waiting`, and resolve it from
  `dsh_task_approve` / `dsh_task_answer`.
- `deny`: fail closed and fail the task with `approval_required` / `question_unavailable`.
- `host`: delegate with `next()`; a missing answerer fails closed.

Pending requests are process-local. A restart marks the task `interrupted`.

## Persistence

One JSON file per task under
`$DSH_HOME/storages/dsh-task-delegation/tasks/<taskId>.json`. Writes are serialized per
task, written to a temporary file in the same directory, then renamed. The record holds
the task, final answer, pending snapshot, error, and `fromSeq`/`toSeq`. The full
transcript stays in DSH session persistence and is read only by `dsh_task_trace`.

## Lifecycle

`apply()` validates config, initializes the store and recovery, constructs the adapter and
manager, starts the HTTP listener, and registers a Cordis cleanup effect. Cleanup closes
the HTTP transports first, then cancels/force-disposes tasks, disposes pooled agents,
closes the store, and clears timers and maps.

## Test strategy

- Unit: config, store, trace formatter.
- Manager: queue/locks, waiting, cancel/timeout, answer validation, recovery.
- Adapter: fake DSH context that exercises create/resume, preset mount, final answer,
  approvals, questions, cancellation, pool reuse, and persisted traces.
- MCP: `InMemoryTransport` asserts tool schemas and exact result envelopes.
- HTTP: `/healthz`, auth, origin, body limit, MCP initialize, session handling.
- Manual: install into a dev profile and verify `/healthz`, tools/list, task persistence,
  and restart behavior. A real model call needs DSH credentials.
