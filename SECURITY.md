# Security Policy

`dsh-task-delegation-mcp` is a local-first MCP server that asks DeepSeek Harness to run
tools, including shell commands and file writes, with the DSH host user's permissions. It
is not a sandbox. Treat the MCP endpoint and its bearer token as a local root credential.

This is an unofficial community project, not affiliated with DeepSeek. It is pre-1.0 and
has not received an external security audit. Review and test it before relying on it for
untrusted workloads.

## Supported versions

| Version | Supported |
|---|---|
| `0.1.x` (pre-1.0) | Security fixes land on `main`; no LTS branch |

Older commits, forks, and modified builds are not supported. Pin a release tag when you
need reproducible behavior.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting**: repository **Security** tab →
**Report a vulnerability**. Do not open a public issue with exploit details, tokens,
prompts, file contents, or customer data.

If private reporting is unavailable, open a public issue that only says you have a
security report and asks for a private channel. Do not include the details until a private
channel exists.

Please include, when possible:

- affected version or commit;
- the DSH version, OS, and profile shape;
- a minimal reproduction;
- impact and required preconditions;
- whether the issue also affects a fresh install.

Do not test against systems or data you do not own. Do not include live credentials.

Acknowledgment and fixes are best-effort on a volunteer, no-SLA basis. This project has no
bug bounty. Coordinated disclosure is preferred; credit is optional.

## In scope

- Bearer-token authentication or `Origin` checks that can be bypassed.
- `cwd` / `workspaceRoots` containment escapes.
- Cross-task or cross-session data leakage, including trace range mistakes.
- Approval or question routing that lets the remote caller bypass the configured policy,
  or that lets one session answer another session's request.
- Secrets exposed by logs, `/healthz`, task records, or trace output contrary to the
  documented contract.
- Runtime dependency vulnerabilities that are reachable through the plugin.

## Out of scope

- Vulnerabilities in DeepSeek Harness, the model provider, or other plugins.
- The fact that this server can execute code or modify files: that is its purpose.
- Prompt injection or unsafe model output that does not cross a documented security
  boundary.
- Operator misconfiguration: exposing the port to the internet, using a weak or shared
  token, enabling `interactions.mode: remote` on an untrusted network, or granting
  `danger-full-access`.
- Issues that require an attacker who already controls the DSH host user account, the
  profile files, or the bearer token.

## Security documentation

See [docs/security.md](docs/security.md) for defaults, authentication, approval authority,
workspace containment, data handling, and network exposure. The MCP tools and their
result contract are documented in [docs/spec/03-tools.md](docs/spec/03-tools.md).

## Disclosure

Please allow time for a fix and a release before publishing details. Confirmed issues will
be noted in `CHANGELOG.md` and, when appropriate, in a GitHub security advisory.
