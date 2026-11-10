# dsh-task-delegation-mcp

**An MCP server that lets external agents delegate coding tasks to DeepSeek Harness.**

A planner agent decides *what* to do. DeepSeek Harness does it: it has a real workspace,
a shell, file tools, subagents, sessions, and presets. This project connects the two over
MCP, so the planner can hand over a task, keep its own context small, and receive the DSH
agent's final answer — a complete document or a single sentence — plus only the state it
needs for the next call.

```text
MCP client (planner)
   │  dsh_task_submit / dsh_task_wait / dsh_agent_run
   ▼
dsh-task-delegation-mcp  (inside DSH)
   │  queue · sessions · approvals · persistence · auth
   ▼
DeepSeek Harness (executor)
   bash · fs · grep · web · subagents
```

## What it gives the caller

- **Context isolation.** The caller does not need to load the repository.
- **Session reuse.** Tasks in the same workspace reuse a DSH session until it is idle.
- **Async by default.** Submit returns a `taskId` immediately; wait only when needed.
- **Final answer, verbatim.** `content` is the DSH agent's last assistant message; no
  mandatory JSON summary and no `changes/verification/leftovers` schema.
- **Explicit blockers.** Approval and user-question requests produce `waiting`, a
  `requestId`, and the exact tool to call next.
- **Trace on demand.** A paginated, readable transcript instead of dumping history into
  every result.
- **Local-first security.** Loopback by default, optional bearer token, origin checks,
  workspace allowlist, and approval modes that fail closed.

## Status

The core implementation is complete and tested. The contract is documented in the
[core specification](docs/spec/README.md); the [roadmap](docs/spec/07-roadmap.md) lists
release work that remains.

| Capability | Status |
|---|---|
| DSH plugin + Streamable HTTP MCP server | done |
| Task queue, session pool, final-answer extraction | done |
| Persistence, restart recovery, retention | done |
| `waiting` + approval/user-question tools | done |
| Readable paginated trace | done |
| Bearer auth, origin check, body limit, workspace roots | done |
| Unit, MCP in-memory, HTTP, and fake-DSH integration tests | done |
| Real-model E2E | done |
| Extension tools (`dsh_capabilities`, `dsh_session_*`) | not in core |

## Tools

| Tool | Purpose |
|---|---|
| `dsh_task_submit` | Enqueue a task and return `taskId` immediately |
| `dsh_task_get` | Read the current state without waiting |
| `dsh_task_wait` | Wait for terminal, `waiting`, or timeout |
| `dsh_agent_run` | `submit` + `wait`; always returns `taskId` |
| `dsh_task_cancel` | Cancel a queued/running task or its pending interaction |
| `dsh_task_list` | List recent task summaries |
| `dsh_task_approve` | Decide a pending approval with `allow-once` or `reject` |
| `dsh_task_answer` | Answer pending user questions |
| `dsh_task_trace` | Read a task's execution transcript in pages |

### Result shape

- `content` is the model-facing channel. On success it is the final answer exactly as the
  DSH agent wrote it. While waiting it is a short hint naming the next tool and IDs. On an
  error it is a recovery hint.
- `structuredContent` is minimal machine state: `taskId`, `status`, `sessionId`,
  `queuePosition`, `blockedBy`, `progress`, `pending`, or `error`.
- `queued`, `running`, and `waiting` are normal states, not `isError` failures.
- A wait timeout is a normal result, not an error. Its content names the effective wait and,
  when the requested value exceeded `interactions.maxWaitMs`, the configured cap.
- An invalid approval/answer never mutates the pending request.

Successful call:

```json
{
  "content": [{ "type": "text", "text": "# Report\n\nAll tests pass." }],
  "structuredContent": { "taskId": "t_abc123", "status": "succeeded", "sessionId": "s_456" }
}
```

Waiting for approval:

```json
{
  "content": [{
    "type": "text",
    "text": "Task t_abc123 is waiting for approval (requestId a_1): bash — write to /etc (expires at ...).\nCall dsh_task_approve with decision \"allow-once\" or \"reject\"."
  }],
  "structuredContent": {
    "taskId": "t_abc123",
    "status": "waiting",
    "sessionId": "s_456",
    "pending": {
      "kind": "approval",
      "requestId": "a_1",
      "toolName": "bash",
      "reason": "write to /etc",
      "expiresAt": "2026-11-10T15:35:00.000Z"
    }
  }
}
```

Continue with:

```json
{ "tool": "dsh_task_approve", "arguments": { "taskId": "t_abc123", "requestId": "a_1", "decision": "allow-once" } }
```

## Quick start

Requirements: DeepSeek Harness `0.2.2-rc.1` or another `0.2.x` release, Node.js >= 22,
and a configured DSH model.

```bash
npm install
npm run build
```

Install into a DSH profile. A dedicated profile keeps experiments separate:

```bash
dsh --profile dev --from-default-profile web --dump-config
dsh plugin --profile dev add link:/absolute/path/to/dsh-task-delegation-mcp
```

The server listens on `127.0.0.1:8957` by default. To change the port or require a
bearer token, add a patch to `$DSH_HOME/profiles/dev/cordis.patch.yml`:

```yaml
- id: dsh-task-delegation
  config:
    http:
      host: 127.0.0.1
      port: 8957
      authToken: !!js process.env.DSH_MCP_TOKEN
```

Start DSH and point the MCP client at `http://127.0.0.1:8957/mcp`:

```bash
dsh --profile dev --no-open
```

```json
{
  "mcpServers": {
    "dsh": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://127.0.0.1:8957/mcp"]
    }
  }
}
```

First task:

```json
{
  "tool": "dsh_agent_run",
  "arguments": {
    "task": "Run the test suite and fix the first failure.",
    "cwd": "/absolute/path/to/repo",
    "timeoutMs": 120000
  }
}
```

Verify the plugin without an MCP client:

```bash
curl http://127.0.0.1:8957/healthz
```

## Configuration

```ts
interface Config {
  http?: {
    host?: string              // default: 127.0.0.1
    port?: number              // default: 8957; 0 = ephemeral
    authToken?: string         // required when host is not loopback
    allowedOrigins?: string[]  // default: loopback origins; empty array denies browsers
    maxBodyBytes?: number      // default: 1 MiB
  }
  agent?: {
    preset?: string            // default: standard
    provider?: string          // default: DSH agentDefaultModel
    model?: string             // default: DSH agentDefaultModel
    reasoningEffort?: string
    maxAgents?: number         // default: 8
    maxConcurrent?: number     // default: 4
    defaultTimeoutMs?: number  // default: 600_000
    defaultSyncWaitMs?: number // default: 30_000
    idleTtlMs?: number         // default: 1_800_000
    maxAnswerBytes?: number    // default: 65_536
  }
  tasks?: {
    storePath?: string         // default: $DSH_HOME/storages/dsh-task-delegation/tasks
    ttlMs?: number             // default: 7 days
    maxRetained?: number       // default: 1_000
    maxQueue?: number          // default: 100
  }
  interactions?: {
    mode?: 'remote' | 'deny' | 'host' // default: remote on loopback, deny elsewhere
    approvalTimeoutMs?: number         // default: 300_000
    questionTimeoutMs?: number         // default: 300_000
    maxWaitMs?: number                 // default: 1_800_000
  }
  workspaceRoots?: string[]
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}
```

A non-loopback `host` without `authToken` is rejected at startup. `interactions.mode:
'remote'` on a non-loopback bind must also be explicit; the safe default there is `deny`.

## Design

- One execution primitive: a task. `dsh_agent_run` is only `submit + wait`.
- Session allocation happens at execution start, never at submit.
- Tasks sharing a `cwd`/preset/model pool key, or an explicit `sessionId`, are serialized.
  New work queues with `blockedBy` and `queuePosition`; it is not rejected as "busy".
- `waiting` covers both approval and user questions; `pending.kind` tells the caller which
  tool to use.
- `dsh_task_trace` reads the task's session-log range, so a reused session does not leak a
  later task's history.
- Task files are written atomically. On restart, queued tasks are re-queued,
  running/waiting tasks become `interrupted`, and completed answers remain readable.
- No mutable plugin state lives at module scope; each `apply()` owns its runtime.

## Development

```bash
npm install
npm run typecheck   # src and tests
npm run build       # clean tsc build into lib/
npm test            # vitest
npm run check:lib   # rebuild and fail if committed lib/ is stale
```

75 tests cover config validation, the task state machine, queue/locks, approval and question
routing, persistence/recovery, trace formatting and pagination, MCP tool results, HTTP
auth/origin/body limits, and a fake-DSH adapter. See
[docs/spec/06-operations.md](docs/spec/06-operations.md) for the full matrix.

## Compatibility

- DeepSeek Harness `0.2.2-rc.1` (npm `next` tag), `>=0.2.2-0 <0.3.0`
- Node.js >= 22
- Linux (bash + bubblewrap), Windows (pwsh)

See [docs/compatibility.md](docs/compatibility.md),
[docs/dsh-internals.md](docs/dsh-internals.md), and
[docs/security.md](docs/security.md).

## Security

This server can execute code with the DSH host user's permissions. Keep it bound to
loopback. If another process or user can reach the port, set a long random
`http.authToken` and do not expose the port to the internet. Approval decisions are
audited and never auto-approved. See [docs/security.md](docs/security.md).

## License

MIT
