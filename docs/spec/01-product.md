# 01 — Product and scope

## 1. Problem

A planner agent can decide what to do, but it usually lacks a real coding environment: a
shell, file tools, a workspace, and a long-lived session. DeepSeek Harness has all of that.
Handing a task from a planner to DSH today means one of:

- loading the whole repository into the planner's context, or
- shelling out to a one-shot process and losing the session, or
- writing a bespoke integration per planner.

This project makes DSH a first-class execution backend over MCP.

## 2. Target users

- An individual developer using an MCP-capable planner (Hermes, Claude Desktop, Cursor,
  or a custom agent).
- An agent framework that needs a local coding executor without reimplementing DSH's
  tools, sandbox, and presets.
- A DSH user who wants to delegate work from another agent without leaving DSH's
  workspace and permission model.

## 3. Jobs to be done

- "Run this scoped task in this repository and give me your final answer."
- "Keep using the same DSH session; do not reload the project on every call."
- "Run a long task in the background and let me inspect, wait for, or cancel it."
- "If DSH needs approval or an answer, tell me what to do and let me respond."
- "Show me the execution trace when I need to debug or hand off context."
- "Run independent tasks for different workspaces without them stepping on each other."

## 4. Non-goals

- Not a new coding agent or model. DSH is the executor.
- Not a remote multi-tenant service. The core release is local-first.
- Not a replacement for the DSH UI, `dsh headless`, or ACP.
- Not an approval bypass. The caller cannot silently grant permissions.
- Not a structured-report generator. The DSH agent decides the final document's format.

## 5. Principles

### 5.1 Results are messages to an agent

The caller reads `content`; it does not parse a frontend-shaped DTO. The final answer is
text — a formal document or one sentence — returned verbatim. `structuredContent` carries
only the identifiers and state needed for the next call.

### 5.2 One execution primitive

Every execution is a task. `dsh_agent_run` is not a second execution path; it is
`dsh_task_submit` followed by `dsh_task_wait`.

### 5.3 Session reuse is the default

A task without `sessionId` reuses the pooled session for its `cwd + preset + provider +
model`, or creates one. `sessionMode: 'fresh'` is the explicit isolation escape hatch.

### 5.4 Interactions are explicit

Approvals and user questions are first-class states. The caller is told which tool to call
and which `requestId` to use. The bridge never auto-approves; an operator can opt in to
DSH Auto review, which may allow a reviewed action.

### 5.5 Bounded default outputs, explicit detail

`get`/`wait` return a small `TaskState` plus the final answer. Full history is opt-in via
`dsh_task_trace`. No duplicated answer in `structuredContent`.

### 5.6 Local-first security

Loopback by default, bearer token, origin check, body limit, cwd allowlist. Remote
exposure requires explicit configuration.

### 5.7 No mandatory report schema

The plugin does not require `changes / verification / leftovers`, does not append a
"one-line JSON summary" instruction, and does not parse the final document. If the caller
wants structure, it can ask for it in the task or use a future summary extension.

## 6. Scope

### 6.1 Core release — ships together

Everything below is required for the first usable release. There is no v0.1/v0.2 split of
these capabilities.

| Area | Included |
|---|---|
| MCP server | Streamable HTTP `/mcp`, `GET /healthz` |
| Execution | `dsh_task_submit`, `dsh_task_get`, `dsh_task_wait`, `dsh_agent_run`, `dsh_task_cancel`, `dsh_task_list` |
| Sessions | Pool, reuse, `fresh`, `sessionId` resume, per-session serialization |
| Persistence | Per-task JSON, restart recovery, TTL, retention |
| Progress | One-line `progress` while running; `blockedBy`/`queuePosition` while queued |
| Interactions | `waiting` + `pending`; `dsh_task_approve`, `dsh_task_answer`; timeouts; audit |
| Trace | `dsh_task_trace`: readable transcript, pagination, filters |
| Security | Bearer token, origin check, body limit, cwd allowlist, approval policy |
| Results | Final answer in `content`; minimal `TaskState` in `structuredContent` |
| Quality | Unit/MCP/HTTP tests, CI, build from `src` |

### 6.2 Extensions — after the core release

- `dsh_capabilities`: presets, default model, limits.
- `dsh_session_list`, `dsh_session_attach`, `dsh_session_rename`.
- MCP progress notifications (the progress data itself is core).
- A structured summary tool, if users want `changes/verification/leftovers` without
  parsing the document.
- Per-task `preset` / `provider` / `model` / `reasoningEffort` overrides.
- Idempotency key on submit; task priority.
- Host/UI approval mode (`next()` to a host answerer) as an alternative to remote
  approval.
- Multiple named bearer tokens with per-token policies.

### 6.3 Later

- OAuth, remote access, TLS termination guidance.
- MCP resources for task traces and artifacts.
- Metrics (Prometheus/OpenTelemetry), webhooks.
- Per-token quotas and rate limits.
- Docker/container deployment notes.

## 7. Terminology

| Term | Meaning |
|---|---|
| Caller | The MCP client / planner agent |
| Executor | A DSH agent mounted with a preset |
| Workspace | A canonical `cwd` (`realpath`) |
| Session | A DSH session, reusable across tasks |
| Task | One unit of work with a `taskId`, persisted |
| Lease | Exclusive use of one agent session by one task |
| Pool key | `cwd + preset + provider + model + reasoningEffort` |
| `TaskState` | The minimal machine state in `structuredContent` |
| `TaskSummary` | The compact item returned by `dsh_task_list` |
| Trace | The task-scoped, readable execution transcript |
| Pending | The approval or question currently blocking a task |

## 8. Product success criteria

A caller can, with one MCP session:

1. Submit a task and get its `taskId` immediately.
2. Wait for it without busy-polling.
3. Receive a formal final document or a one-sentence answer verbatim.
4. Be told, with the correct tool and `requestId`, when DSH needs approval or an answer.
5. Cancel, inspect, or continue the same session.
6. Retrieve a readable trace for debugging.
7. Restart DSH and still read a completed task's answer.
8. Do all of the above without the answer being duplicated in structured fields or
   distorted by a mandatory JSON summary.
