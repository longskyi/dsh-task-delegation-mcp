# dsh-task-delegation-mcp — core specification

Status: **v1 core implemented.** The source and tests follow this document. See
[07-roadmap.md](07-roadmap.md) for the exact status.
Scope: the first usable release. Internal milestones are sequencing only; they are not
user-facing feature cuts.

## What this is

An MCP server embedded in DeepSeek Harness that lets an external agent delegate a task
to DSH and receive the DSH agent's final answer. DSH executes in its own workspace and
session; the caller keeps its own context small.

The caller is an **agent**, not a frontend. Tool results are designed to be read by an
agent: the answer is text, and only the identifiers needed for the next call are
structured.

## The contract in one page

- One execution primitive: a **task**.
- `dsh_task_submit` enqueues a task and returns its `taskId` immediately.
- `dsh_agent_run` is the `submit + wait` convenience; when the call returns, it includes
  the `taskId`.
- `dsh_task_get` reads the current state instantly. `dsh_task_wait` blocks until the
  task reaches a terminal state, becomes `waiting`, or the timeout expires.
- Sessions are allocated **at execution start**, not at submit. Without `sessionId`, the
  pool key is `cwd + preset + permissionPreset + provider + model + reasoningEffort`; an
  idle session is reused, otherwise one is created. `sessionMode: 'fresh'` forces a new
  session.
- On success, `content` is the DSH agent's final answer **verbatim** — a complete
  document or a single sentence. It is never wrapped in JSON.
- `structuredContent` is a minimal `TaskState`: `taskId`, `status`, `sessionId`,
  `pending`, `error`, queue information. It never duplicates the answer.
- `status: 'waiting'` plus `pending` tells the caller to call `dsh_task_approve` or
  `dsh_task_answer`.
- `dsh_task_trace` returns a readable transcript in pages. It is for inspection, not for
  the normal success path.
- There is no mandatory `changes / verification / leftovers` schema and no JSON summary
  parsing. The final document is the result.
- Local-first security. Approvals and answers are explicit, `allow-once`, and audited.

## Reading order

1. [Product and scope](01-product.md)
2. [Execution, sessions, persistence](02-execution.md)
3. [MCP tools and result shape](03-tools.md)
4. [Approvals and user questions](04-interactions.md)
5. [Security](05-security.md)
6. [Configuration and operations](06-operations.md)
7. [Core vs extensions, milestones](07-roadmap.md)

## Decision summary

| Decision | Value |
|---|---|
| Execution primitive | One task model; sync is `submit + wait` |
| Submit behavior | Enqueue immediately; session allocated at execution start |
| Session default | Reuse by pool key; `sessionMode: 'fresh'` opt-in |
| Waiting states | One `waiting` status; `pending.kind` is `approval` or `question` |
| Success result | Final assistant message in `content`; `TaskState` in `structuredContent` |
| Structured summary | Not mandatory; no `parseSummary` in the core |
| Progress | One-line `progress` while running; full detail via `dsh_task_trace` |
| Trace | Readable transcript, paginated, reasoning opt-in |
| Approval policy | `remote` default on loopback; `deny` available; non-loopback explicit; `host` experimental |
| Token model | Single bearer token in the core release |
| Persistence | Per-task JSON, atomic writes, restart recovery |
| Compatibility | DSH `0.2.2-rc.1`, Node >= 22, Linux/Windows |
