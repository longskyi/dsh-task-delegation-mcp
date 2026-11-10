import { resolveConfig, type Config, type ResolvedConfig } from './config.js'
import { Logger } from './logger.js'
import { readVersion } from './version.js'

/** Per-`apply` runtime. Never store mutable plugin state at module scope. */
export interface Runtime {
  readonly version: string
  readonly config: ResolvedConfig
  readonly logger: Logger
  readonly startedAt: number
}

/** Build a runtime from plugin config, validating it first. */
export function createRuntime(config: Config = {}): Runtime {
  const resolved = resolveConfig(config)
  return {
    version: readVersion(),
    config: resolved,
    logger: new Logger(resolved.logLevel),
    startedAt: Date.now(),
  }
}
