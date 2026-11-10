import type { LogLevel } from './config.js';
/** Small dependency-free logger. Keeps the DSH host's stdout/stderr usable. */
export declare class Logger {
    private readonly level;
    private readonly scope;
    constructor(level: LogLevel, scope?: string);
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    private write;
}
