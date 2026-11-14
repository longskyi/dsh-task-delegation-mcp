# Security

`dsh-task-delegation-mcp` exposes an MCP endpoint that asks DeepSeek Harness to run
tools, including shell commands and file writes. Treat the port as a remote-execution
interface, not a read-only API.

## Defaults

- The listener binds to `127.0.0.1`.
- `http.authToken` is optional on loopback and **required** for any non-loopback bind.
  Startup fails if a non-loopback host is configured without a token.
- A non-loopback bind defaults to `interactions.mode = 'deny'`. Remote approval must be
  enabled explicitly.
- Browser `Origin` values are checked on `/mcp`; the default allowlist contains the
  loopback origins for the configured port. A non-loopback bind defaults to an empty
  allowlist, so browser requests are denied unless `http.allowedOrigins` is set.
  Requests without `Origin` (CLI clients) are allowed.
- At most 64 MCP transport sessions are kept; idle sessions are closed after 10 minutes.
- `Content-Length` above `http.maxBodyBytes` is rejected with `413`; the SDK transport
  also enforces the same bound for chunked bodies.
- `cwd` is canonicalized with `realpath`; optional `workspaceRoots` are canonicalized at
  startup and enforced with a path-relative containment check.
- `GET /healthz` is unauthenticated and reports only status, name, version, uptime, and
  queue/agent counts. It never includes task ids, session ids, prompts, or answers.

## Authentication

Use a long random bearer token:

```yaml
- id: dsh-task-delegation
  config:
    http:
      authToken: !!js process.env.DSH_MCP_TOKEN
```

The server compares `Authorization: Bearer <token>` in constant time and does not log the
token. A holder can execute code with the DSH host user's permissions; treat the token as
a local root credential. The core release has one token.

## Approval authority

The token holder can already execute code, so remote approval does not create a new
attacker. It does create a policy question: may the caller approve an escalation beyond
the DSH sandbox?

- Loopback defaults to `interactions.mode = 'remote'`.
- Non-loopback must opt in to `remote`; otherwise it uses `deny`.
- Approval through the bridge is one-shot (`allow-once`) or `reject`; the bridge never
  auto-approves. Opt-in Auto review is a separate reviewer path and has no
  persistent grant.
- Every decision is audited with `taskId`, `requestId`, kind, and decision. Payloads,
  prompts, and file contents are not logged.
- `host` mode delegates to the DSH UI/host answerer and is experimental; a missing
  answerer fails closed.

## Workspace

- Resolve `cwd` with `realpath`; a missing directory is rejected before task creation.
- If `workspaceRoots` is configured, each root is canonicalized at startup; a missing
  root is a startup error. Containment uses `path.relative()` so Windows and POSIX both
  work.
- Continuing an explicit `sessionId` requires the session header's `cwd` to match the
  task `cwd`; otherwise the task fails with `cwd_mismatch`.
- The default is unrestricted for a trusted local caller. Configure `workspaceRoots` for
  production or multi-tenant use.

## Data and privacy

- Task files store the task, context, final answer, progress, and bounded state.
- The full transcript remains in DSH session persistence and is read only for the task's
  `[fromSeq, toSeq)` range by `dsh_task_trace`.
- Trace content can contain secrets because tool output can contain secrets. The token and
  trace are sensitive.
- Do not log prompts, tool arguments, file contents, final answers, tokens, or approval
  payloads.

## Network exposure

- Keep the default loopback binding.
- Do not expose the port to a LAN or the internet without a reverse proxy, TLS, and
  authentication.
- If DSH runs in a container, bind only the interface the caller can reach and firewall
  everything else.
- TLS is not implemented in the plugin in the core release; terminate it at a proxy.

## Reporting

Open a private GitHub security advisory for suspected vulnerabilities. Do not include
tokens, prompts, or file contents in a public issue.
