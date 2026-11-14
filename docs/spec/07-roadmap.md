# 07 — Core scope, extensions, milestones

## 1. Core release

All of this ships together. There is no "v0.1 without interactions" or "v0.2 adds
trace".

| Area | Included |
|---|---|
| MCP server | Streamable HTTP `/mcp`, `GET /healthz`, bearer auth, origin check, body limit |
| Tasks | submit/get/wait/run/cancel/list; one task primitive |
| Sessions | pool, reuse, `fresh`, `sessionId` resume, per-session serialization |
| Persistence | per-task JSON, restart recovery, TTL, retention |
| Progress | one-line `progress`; `queuePosition`/`blockedBy` |
| Interactions | `waiting` + `pending`; approve/answer; timeouts; audit |
| Trace | readable transcript, filters, pagination |
| Results | final answer verbatim in `content`; minimal `TaskState` in `structuredContent` |
| Security | local-first defaults; approval policy; cwd allowlist |
| Permissions | per-task `permissionPreset` allowlist; Auto review routing |
| Quality | unit/MCP/HTTP tests, CI, build from `src` |

## 2. Extensions (after core)

- `dsh_capabilities`: presets, default model, limits.
- `dsh_session_list`, `dsh_session_attach`, `dsh_session_rename`.
- MCP progress notifications (the progress data is already core).
- Optional structured summary tool (`changes/verification/leftovers`) for callers that
  want it without parsing the final document.
- Per-task `preset` / `provider` / `model` / `reasoningEffort` overrides.
- Idempotency key on submit; task priority.
- Host/UI approval mode (`next()` to a host answerer) after session-ownership
  verification.
- Multiple named bearer tokens with per-token policies.

## 3. Later

- OAuth, remote access, TLS termination guidance.
- MCP resources for traces and artifacts.
- Metrics (Prometheus/OpenTelemetry), webhooks.
- Per-token quotas and rate limits.
- Docker/container deployment notes.

## 4. Deferred decisions (with defaults)

These do not block the core implementation; the listed default is in the spec.

| Decision | Default | Defer because |
|---|---|---|
| Primary MCP client | Client-agnostic HTTP; document `mcp-remote` | The protocol surface is the same |
| Per-task model/preset overrides | Config-level only; extension | Keeps the pool key stable in the core |
| `dsh_capabilities` / session tools | Extension | Not needed to run/delegate/inspect a task |
| Progress notifications | Extension | Long-poll + `progress` string is enough; client support varies |
| Multiple tokens | Single token | Trust boundary is already the token |
| Retention | 7 days / 1,000 tasks | Configurable; defaults are safe |
| Host approval mode | Experimental | Needs session-ownership verification |

## 5. Internal milestones

Milestones are implementation sequencing, not feature cuts. Every milestone ends with a
demoable slice.

**Status:** M0–M4 are implemented and covered by tests. The plugin has been exercised in
a development profile and with real-model E2E runs. M5 covers packaging and release.

### M0 — scaffold (done)

- Plugin entry, HTTP server, `/healthz`, `echo`, auth, config validation, tests, CI.
- Build from `src`; `lib/` generated.

### M1 — execution core (done)

- Task store interface + in-memory test store.
- `dsh_task_submit`, `dsh_task_get`, `dsh_task_wait`, `dsh_agent_run`.
- Session pool, preset/model resolution, final answer extraction.
- Cancel and timeout.
- Fake-context tests.

### M2 — persistence and interactions (done)

- JSON task store, recovery, TTL.
- `waiting` state, approval/question answerers, approve/answer tools.
- Wrong-kind/stale/duplicate/cancel race handling.
- Audit.

### M3 — trace and discovery (done)

- Task-scoped session range, live/persisted trace.
- `dsh_task_trace`, readable transcript, filters, pagination.
- `dsh_task_list`.
- Interrupted-task progress persistence.

### M4 — hardening (done)

- Auth/origin/body/cwd tests.
- Graceful shutdown, transport cleanup, agent disposal.
- Windows/Linux CI.
- E2E against a real DSH dev profile.

### M5 — release (not started)

- README/spec/docs, CHANGELOG, version, tag.
- Optional npm publish or GitHub release tarball.
- Optional switch of an existing deployment from an earlier plugin.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| DSH internal API changes | Pin `0.2.2-rc.1`; adapter layer; compatibility doc; CI against `next` when ready |
| Approval/question answerer ownership (UI vs plugin) | M2 spike; `remote` default on loopback; `deny`/`host` options; fail closed |
| Trace unavailable after compaction/deletion | Store `sessionId` + range; return `trace_unavailable`, never fake completeness |
| Long final answer blows caller context | `maxAnswerBytes`, explicit truncation marker, trace, prompt encourages file + path |
| Session reuse bleeding context | `sessionMode: 'fresh'`; clear session per workspace |
| Concurrency bugs in cancel/approve races | Per-task actor, CAS transitions, deterministic tests |
| Remote approval abused | Loopback default; non-loopback explicit; allow-once; audit |
| MCP client ignores `structuredContent` | Put actionable IDs/hints in `content` too; structured only for code |

## 7. Release checklist

- [ ] Core acceptance criteria in `06-operations.md` all pass.
- [ ] `npm run check:lib` is clean.
- [ ] CI green on Ubuntu/Windows, Node 22/26.
- [ ] E2E: success, waiting approval, waiting question, cancel, restart, trace.
- [ ] README links the spec; no stale DTO-style result schema or mandatory-summary claims.
- [ ] Security notes cover token, remote approval, trace privacy.
- [x] Verified in a development profile and with real-model E2E runs.
- [ ] Version/tag and CHANGELOG updated.
