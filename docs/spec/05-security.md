# 05 — Security

## 1. Threat model

The MCP endpoint can ask DeepSeek Harness to run tools, including shell commands and file
writes. Treat it as a **remote-execution interface**, not a read-only API.

| Adversary | Capability | Required protection |
|---|---|---|
| Process on the same host without the token | Can reach `127.0.0.1:8957` | Bearer token; fail closed |
| Process with the token | Can delegate code execution | Token is the trust boundary; explicit approval policy; audit |
| Browser page / DNS-rebinding attacker | Can send requests with a forged Origin/Host | Origin check; loopback bind; MCP SDK DNS-rebinding protections where available |
| Malicious workspace content | Can influence the agent through files/prompts | DSH sandbox/permissions; cwd allowlist; no automatic approval |
| Network attacker | Can reach a non-loopback bind | Explicit opt-in; token; TLS/reverse proxy; firewall |
| Trace reader | Can see code/tool outputs | Token-protected; retention; no logging of transcripts |

This project does not create a new sandbox. It uses DSH's sandbox and permission model.
The caller can never silently escalate DSH's sandbox mode.

## 2. Defaults

- Bind `127.0.0.1`.
- `http.authToken` is optional on loopback, **required** for any non-loopback bind.
- Non-loopback bind without a token → startup fails.
- Non-loopback bind defaults to `interactions.mode = 'deny'`; `remote` approval must be set
  explicitly.
- `Origin` is checked on `/mcp`; the default allowlist contains the loopback origins for
  the configured port. A non-loopback bind defaults to an empty allowlist, so browser
  requests are denied until `http.allowedOrigins` is set. Requests without `Origin`
  (CLI clients) are allowed.
- At most 64 MCP transport sessions are retained; idle sessions are closed after 10
  minutes. This bounds abandoned-client state.
- `Content-Length` over `http.maxBodyBytes` (default 1 MiB) is rejected with `413`; the
  MCP transport enforces the same bound for chunked bodies.
- `cwd` is canonicalized with `realpath` and checked against `workspaceRoots` when
  configured.
- `GET /healthz` is unauthenticated and reports only status, name, version, uptime, and
  queue/agent counts.

## 3. Authentication

- `Authorization: Bearer <token>` on every `/mcp` request.
- Constant-time comparison; do not log the token.
- Load the token from the environment in the profile patch:

  ```yaml
  - id: dsh-task-delegation
    config:
      http:
        authToken: !!js process.env.DSH_MCP_TOKEN
  ```

- Use a long random value. The token is a local root credential: a holder can execute code
  with the DSH host user's permissions.
- The core release has one token. Multiple named tokens with per-token policies are an
  extension.

## 4. Approval authority

The token holder can already execute code, so remote approval does not create a new
attacker. It does create a policy question: should the caller be allowed to approve an
escalation beyond the sandbox?

The core release:

- Defaults to `interactions.mode = 'remote'` on loopback.
- Requires explicit `remote` on non-loopback.
- Offers `deny` for deployments that want DSH's human approval layer to remain the only
  path.
- Uses `allow-once` only.
- Audits every decision.
- Never auto-approves.
- Treats `host` (UI answerer) as experimental until session ownership is verified.

An autonomous caller can self-approve if the operator grants it a token and `remote`
mode. That is an explicit delegation of trust, not a hidden default.

## 5. cwd and workspace

- Resolve `cwd` with `realpath`; reject a missing directory.
- If `workspaceRoots` is configured, canonicalize each root too and enforce containment
  with a path-relative check (win32/posix safe).
- `sessionId` continuation must match the session header's `cwd`; otherwise
  `cwd_mismatch`.
- The default is unrestricted for a local trusted caller; production deployments should
  configure `workspaceRoots`.

## 6. Audit and privacy

- Audit approval/question decisions with `taskId`, `requestId`, kind, tool/question ids,
  decision, and timestamp.
- Do not log prompts, full tool arguments, file contents, or the final answer.
- The task record stores the final answer and a bounded progress string; the full
  transcript remains in DSH session persistence and is read on demand by the trace.
- `dsh_task_trace` is token-protected and returns only the task's session range; it must
  not expose other tasks' events.
- Trace content can contain secrets because tool outputs can contain secrets. Treat the
  token and trace as sensitive.

## 7. Error messages

- Do not leak other tasks' existence: unknown `taskId` → `task_not_found`.
- Do not include stack traces, file paths outside the workspace, or internal service
  names in tool errors.
- Do include the current `TaskState` when it helps the caller recover.
- `internal` errors may include a short correlation id; the full detail goes to the DSH
  log.

## 8. Network exposure

- Keep the default loopback binding.
- Do not expose the port to a LAN or the internet without a reverse proxy, TLS, and
  authentication.
- If the DSH host runs in a container, bind only the interface the caller can reach and
  firewall everything else.
- A non-loopback bind requires a token and explicit `remote` approval opt-in.
- TLS is not implemented by the plugin in the core release; terminate it at a proxy.

## 9. Supply chain and compatibility

- Pin the DSH development dependencies to the exact runtime version (`0.2.2-rc.1`).
- Keep `@deepseek-ai/*` as peer dependencies; never bundle a second copy of a DSH core
  package.
- `lib/` is generated by `tsc` and checked in CI; no hand-edited build output.
- CI runs on Ubuntu and Windows, Node 22 and 26.
- Review dependency updates with `npm audit` and the lockfile.

## 10. Reporting

Open a private GitHub security advisory for suspected vulnerabilities. Do not include
tokens, prompts, or file contents in a public issue.
