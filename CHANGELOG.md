# Changelog

## 0.1.0 (unreleased)

Core implementation of the task-delegation MCP server.

### Execution

- `dsh_task_submit`, `dsh_task_get`, `dsh_task_wait`, `dsh_agent_run`,
  `dsh_task_cancel`, and `dsh_task_list`.
- One task primitive; `dsh_agent_run` is submit + wait and always exposes `taskId`.
- Queue with `blockedBy`/`queuePosition`, global `maxConcurrent`, per-session locks, and
  pool-key serialization.
- Session allocation at execution start; pool reuse for `reuse`, a new conversation for
  `fresh`, and explicit `sessionId` resolution through pool → live → persistence.
- Final answer is the last non-empty assistant message in the task's log range, returned
  verbatim in `content`; oversized answers are marked `[truncated]` and bounded by
  `agent.maxAnswerBytes`.
- Progress strings, task timeout, cancellation, and restart recovery.

### Interactions

- `waiting` state for approvals and user questions, with `pending.kind`,
  `requestId`, `expiresAt`, and actionable content hints.
- `dsh_task_approve` and `dsh_task_answer`; invalid/wrong/expired decisions do not mutate
  the pending request.
- `interactions.mode`: `remote`, `deny`, and experimental `host`.
- Per-task `permissionPreset` with an operator allowlist; `auto` selects DSH Auto review.
  Auto-review denials bypass remote approval and fail closed without a host answerer.
- `interactions.maxWaitMs` defaults to 30 minutes; a wait timeout reports its effective
  duration and whether the requested duration was capped.
- Approval/question TTLs and cancellation cleanup.

### Persistence and trace

- Atomic per-task JSON files under `$DSH_HOME/storages/dsh-task-delegation/tasks`.
- Queued tasks re-queue after restart; running/waiting tasks become `interrupted`;
  completed answers remain readable.
- TTL and retained-count pruning.
- `dsh_task_trace`: readable transcript, `afterSeq` pagination, include filters,
  per-event and page truncation flags, and `trace_unavailable` for missing sessions.

### Surface and operations

- Streamable HTTP MCP server on default port `8957`, `/healthz`, bearer auth, origin
  allowlist, body limit.
- `content`/`structuredContent` contract: answer or actionable status in content, minimal
  state in structuredContent.
- Full configuration, startup validation, workspace roots, graceful shutdown.
- 82 tests covering config, store, manager, adapter, bridge, trace, tools, and HTTP.

### Build

- TypeScript `src` → clean `tsc` build into `lib/`, with committed output checked in CI.
- `npm run typecheck` covers both source and tests.
- CI matrix: Ubuntu/Windows × Node 22/26.
