# Compatibility

## Runtime

| Component | Supported |
|---|---|
| DeepSeek Harness | `0.2.2-rc.1` (npm `next` tag), `>=0.2.2-0 <0.3.0` |
| Node.js | `>=22` |
| OS | Linux (bash + bubblewrap), Windows (pwsh) |

The adapter is written against the DSH `0.2.x` agent, preset, session, and persistence
interfaces. It imports no `@deepseek-ai/*` package at runtime; the host resolves the
services through the plugin context, so the plugin cannot install a second copy of a DSH
core package.

## Version policy

- `engines.dsh` is checked before the bundle loads.
- Keep the peer range within `0.2.x`; DSH `0.3` may change internal APIs.
- Pin exact DSH development dependencies (`0.2.2-rc.1`) and use the npm `next` tag only
  when intentionally testing a newer prerelease.

## CI matrix

- Ubuntu and Windows
- Node 22 and 26
- `npm ci`, typecheck (source and tests), clean build, test, and a committed-`lib`
  freshness check
