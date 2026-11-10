# DSH internals notes

Integration rules derived from testing against DeepSeek Harness `0.2.2-rc.1`. Each rule
exists because the behavior is easy to get wrong; keep the corresponding test or probe
when changing the adapter.

## Module identity and scopes

- `scopeOf` must be imported from `@deepseek-ai/dsh-scope`. Never inline a local
  `Symbol('dsh.scope')`: the host uses the package's symbol instance, so an inlined copy
  always returns `undefined`.
- `ctx.agentPresets.mount(agentCtx, preset)` requires a scoped agent context. Check
  `scopeOf(agentCtx)` first and fail loudly if it is missing; skipping the mount silently
  produces an agent with no tools.

## Agent model selection

- `ctx.agents.create()` and `ctx.agents.resume()` need a provider **and** a model. A
  missing model turns the first turn into `turn/end` with
  `agent has no provider/model` and an empty result.
- Prefer an explicit config override; otherwise follow
  `ctx.get('agentDefaultModel')?.currentSelection()`. Do not hard-code a model.
- `AgentOptions.reasoningEffort` is a branded `ReasoningEffortId`, not `string`.

## Message sources

- `MessageSource.kind` is a merge-extensible union. There is no shared `plugin` kind.
  Declare the producer's own kind with module augmentation:

  ```ts
  declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
      'plugin:dsh-task-delegation': { kind: 'plugin:dsh-task-delegation' }
    }
  }
  ```

- Persisted message format v4 rejects a bare `{ kind: 'plugin' }` source.

## Workspaces and cwd

- `cwd` must be canonicalized with `realpath` before it is used as a pool key or compared
  with a workspace path. `attachSession` validates `realpath(session.header.cwd)` against
  `workspace.path` exactly; a trailing slash, `.` segment, or symlink mismatch is rejected.
- `workspaceRegistry.resolveByPath(path) ?? workspaceRegistry.create(path)` is the
  idempotent grouping pattern.
- `workspaceRegistry` is a web-surface service. It is optional in headless/minimal
  profiles; resolve it with `ctx.get`, never declare it as a required `inject`.

## Services and `inject`

- Cordis waits for every service named in `inject`. Listing an optional service there
  prevents the plugin from applying in profiles that do not provide it.
- Required for agent execution: `tools`, `llm`, `agents`, `agentPresets`.
- Optional: `workspaceRegistry`, `sessionPersistence`, `sessions`, `sessionTitle`.

## Session continuation

When a caller supplies a `sessionId`, resolve in this order:

1. The plugin's live pool (by key, or by session-to-key index).
2. `ctx.agents.get(sessionId)` for a UI-opened or otherwise live session.
3. `ctx.agents.resume({ resumeSessionId })` from persistence.

If all three miss, return a typed `session_not_found` error. When the plugin resumed the
session itself, flush it with `ctx.get('sessions')?.flush()` and dispose the handle when
the task ends.

## Event log shapes

Task results are extracted from the session log slice after the task started:

- `assistant/message` — `data.message.content` contains text blocks.
- `tool/call` — tool name and arguments.
- `tool/result` — nested text content.
- `turn/end` — `data.reason.kind === 'error'` means the turn failed; surface it instead of
  returning an empty result.

## DSH versions and npm tags

- The npm `latest` tag for `@deepseek-ai/dsh-*` packages can lag the runtime. For
  `0.2.2-rc.1`, use the `next` tag or an exact version.
- Declare `engines.dsh` in the plugin manifest and keep peer ranges aligned. DSH checks
  `engines.dsh` first, then `@deepseek-ai/dsh*` peers.
- Prereleases participate in semver ranges; `>=0.2.2-0 <0.3.0` accepts `0.2.2-rc.1`.

## Shell and sandbox

- Linux presets enable `tool-bash` and disable `tool-pwsh`; Windows does the opposite.
  Never assume PowerShell.
- DSH's `workspace-write` sandbox uses bubblewrap on Linux. If `bwrap` is missing, writes
  from the agent's shell fail even though the plugin loads.

## Cancellation and shutdown

- `agent.cancel(cause)` aborts the active turn; use it for timeouts and task cancellation.
- `server.close()` does not close keep-alive sockets. Call `server.closeAllConnections()`
  and close every Streamable HTTP transport during plugin teardown.
