# 06 — Configuration and operations

## 1. Configuration

```ts
interface Config {
  http?: {
    host?: string              // default: 127.0.0.1
    port?: number              // default: 8957; 0 = ephemeral (tests)
    authToken?: string         // required when host is not loopback
    allowedOrigins?: string[]  // default: loopback origins; [] denies browser Origins
    maxBodyBytes?: number      // default: 1 MiB
  }
  agent?: {
    preset?: string            // default: standard
    provider?: string          // default: host agentDefaultModel
    model?: string             // default: host agentDefaultModel
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
    ttlMs?: number             // default: 604_800_000 (7 days)
    maxRetained?: number       // default: 1_000
    maxQueue?: number          // default: 100
  }
  interactions?: {
    mode?: 'remote' | 'deny' | 'host'  // default: remote on loopback, deny on non-loopback
    approvalTimeoutMs?: number         // default: 300_000
    questionTimeoutMs?: number         // default: 300_000
    maxWaitMs?: number                 // default: 1_800_000
  }
  workspaceRoots?: string[]
  logLevel?: 'debug' | 'info' | 'warn' | 'error'
}
```

Validation rules:

- `http.port` is an integer 0–65535.
- Non-loopback `host` without `authToken` is a startup error.
- Non-loopback `host` defaults to `interactions.mode = 'deny'`; `remote` must be explicit.
- `tasks.maxQueue` and `agent.maxConcurrent` are positive integers.
- `agent.preset` must exist; otherwise agent creation fails with `agent_unavailable`.
- `workspaceRoots` are canonicalized with `realpath`; a missing root is a startup error.
- `http.allowedOrigins` entries must be origins without paths. Omitted means "loopback
  defaults on a loopback bind, deny browser origins elsewhere"; an explicit empty array
  denies every browser Origin while still allowing requests without an Origin.

## 2. Health

`GET /healthz` (no auth):

```json
{
  "status": "ok",
  "name": "dsh-task-delegation",
  "version": "0.1.0",
  "uptimeMs": 123456,
  "queue": { "queued": 2, "running": 1, "waiting": 0 },
  "agents": { "pooled": 1, "active": 1 }
}
```

It must not include prompts, task ids, or session ids.

## 3. Logging

- Levels: `debug`, `info`, `warn`, `error`; default `info`.
- Task lifecycle: `queued`, `started`, `waiting`, `resumed`, `succeeded`, `failed`,
  `canceled`, `interrupted`.
- Fields: `taskId`, `sessionId`, `cwd`, `durationMs`, `errorCode`, `queueDepth`,
  `agentPoolSize`.
- Do not log prompts, tool arguments, file contents, final answers, tokens, or approval
  decisions' payloads.
- Use stderr for `warn`/`error`; stdout is acceptable for normal lifecycle logs.

## 4. Lifecycle

`apply(ctx, config)`:

1. Validate config.
2. Create the task store; run recovery (queued re-queue, running/waiting → interrupted,
   prune).
3. Create the MCP HTTP server; listen on the configured host/port; log the bound address.
4. Register a Cordis cleanup effect.
5. Start the queue workers and the idle-session reaper.

Cleanup:

- Stop accepting new tasks.
- Cancel or wait for active tasks (bounded).
- Resolve pending interactions as canceled.
- Close every Streamable HTTP transport.
- `server.closeAllConnections()`.
- Dispose pooled agents (flush sessions first).
- Close the task store.
- Clear all maps/timers.

No mutable plugin state lives at module scope; a second `apply()` in the same process gets
its own runtime.

## 5. Persistence paths

- Tasks: `$DSH_HOME/storages/dsh-task-delegation/tasks/<taskId>.json`
- Atomic writes: temp file in the same directory, then rename.
- The task record contains the final answer and the trace sequence range; the full
  transcript remains in DSH session persistence.
- Retention is enforced on startup and periodically.

## 6. Compatibility

| Component | Supported |
|---|---|
| DeepSeek Harness | `0.2.2-rc.1` (npm `next` tag), `>=0.2.2-0 <0.3.0` |
| Node.js | `>=22` |
| OS | Linux (bash + bubblewrap), Windows (pwsh) |
| Package manager for development | npm (lockfile committed) |

The npm `latest` tag for `@deepseek-ai/dsh-*` can lag the runtime. Pin exact
`0.2.2-rc.1` development dependencies; use the `next` tag only when intentionally
testing the next release.

## 7. Build and packaging

- `src/` → `tsc` → `lib/`; no bundler is required.
- `lib/` is committed so `link:` installs from a git checkout work without a build step.
- `npm run check:lib` rebuilds and fails if the committed `lib/` is stale.
- `prepack` builds `lib/` for npm publishing.
- `files`: `lib`, `cordis.yml`, `README.md`, `LICENSE`.
- `cordis.yml` inserts the plugin row with `id: dsh-task-delegation` and
  `name: dsh-task-delegation-mcp`.

## 8. Testing

| Layer | What |
|---|---|
| Unit | config validation, queue, state machine, error mapping, next-step hints |
| MCP in-memory | tool schemas, `content`/`structuredContent`, `isError`, trace formatting |
| HTTP | `/healthz`, auth, origin, body limit, MCP initialize |
| DSH adapter (fake ctx) | session allocation, final answer extraction, cancel, approvals |
| E2E (manual) | install into a dev profile, run `uname -s`, approve a test command, answer a question, restart and read a task |

The DSH-dependent tests use a fake `Context` and a fake `AgentRegistry`; they do not
require a model. E2E is manual because it needs a real DSH account.

## 9. CI

- Matrix: Ubuntu/Windows × Node 22/26.
- `npm ci`, `npm run typecheck`, `npm run build`, `npm test`,
  `git diff --exit-code -- lib`.
- No network access is required at test time beyond npm install.
- `.gitattributes` pins LF so the committed `lib/` check is stable on Windows.

## 10. Development profile

Use a dedicated profile while iterating so an existing deployment is not disturbed:

```bash
dsh --profile dev --from-default-profile web --dump-config
dsh plugin --profile dev add /path/to/dsh-task-delegation-mcp
```

Choose a free port in `$DSH_HOME/profiles/dev/cordis.patch.yml` if the default is already
in use:

```yaml
- id: dsh-task-delegation
  config:
    http:
      port: 8958
      authToken: !!js process.env.DSH_MCP_TOKEN
```

## 11. Core acceptance criteria

1. `npm run typecheck`, `npm run build`, `npm test` pass; `lib/` is fresh.
2. Plugin loads in a dev profile; `/healthz` returns 200.
3. Unauthenticated `/mcp` returns 401 when a token is set; authenticated initialize
   succeeds.
4. `dsh_agent_run` runs `uname -s` and returns `content` containing `Linux` plus a
   `TaskState` with `status: succeeded`.
5. The final answer is returned verbatim: a single sentence and a Markdown document are
   both preserved.
6. `dsh_task_submit` → `dsh_task_wait` reaches `succeeded`; `dsh_task_cancel` cancels a
   long task.
7. A completed task's answer survives a DSH restart and is returned by `dsh_task_get`.
8. `dsh_task_trace` returns a readable transcript, paginates with `afterSeq`, and marks
   truncation.
9. A task that needs approval enters `waiting`, `pending.kind = 'approval'`; a wrong
   `dsh_task_answer` returns `interaction_kind_mismatch` with a hint, and the pending
   stays valid; `dsh_task_approve` resumes the task.
10. A task that needs an answer enters `waiting`, `pending.kind = 'question'`;
    `dsh_task_answer` resumes it.
11. A new run on a busy session is queued with `blockedBy`; a `fresh` run can proceed in
    parallel.
12. A non-loopback bind without a token refuses to start.
13. CI is green on Ubuntu/Windows and Node 22/26.

## 12. Failure and restart table

| Event | Behavior |
|---|---|
| DSH restarts while `running` | Task becomes `interrupted`; no auto-retry |
| DSH restarts while `waiting` | Task becomes `interrupted`; pending cleared |
| DSH restarts while `queued` | Task is re-queued |
| Caller disconnects while `running` | Task continues; caller reconnects with `task_get` |
| Caller disconnects while `waiting` | Pending survives until TTL; caller can reconnect and decide |
| Task store write fails | The task fails with `internal`; the previous record is preserved if possible |
| Port already in use | Startup fails; the plugin logs the bind error |
| Session deleted externally | Task fails with `session_not_found`; trace may be unavailable |
