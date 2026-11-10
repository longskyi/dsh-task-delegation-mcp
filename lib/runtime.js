import { resolveConfig } from './config.js';
import { Logger } from './logger.js';
import { readVersion } from './version.js';
/** Build a runtime from plugin config, validating it first. */
export function createRuntime(config = {}) {
    const resolved = resolveConfig(config);
    return {
        version: readVersion(),
        config: resolved,
        logger: new Logger(resolved.logLevel),
        startedAt: Date.now(),
    };
}
