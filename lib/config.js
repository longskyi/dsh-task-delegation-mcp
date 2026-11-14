/** Plugin configuration: input shape, defaults, and validation. */
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
const INTERACTION_MODES = ['remote', 'deny', 'host'];
function stringList(value, field) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        throw new Error(`${field} must be an array of non-empty strings`);
    const result = [];
    for (const item of value) {
        if (typeof item !== 'string' || item.trim() === '') {
            throw new Error(`${field} entries must be non-empty strings, got ${String(item)}`);
        }
        const trimmed = item.trim();
        if (!result.includes(trimmed))
            result.push(trimmed);
    }
    return result;
}
/** Whether `host` only accepts local connections. */
export function isLoopbackHost(host) {
    return LOOPBACK_HOSTS.has(host);
}
/**
 * Apply defaults and validate the plugin configuration.
 * @throws when a port, body limit, log level, workspace root, or non-loopback
 *   binding is unsafe.
 */
export function resolveConfig(input = {}) {
    const http = input.http ?? {};
    const rawHost = (http.host ?? '127.0.0.1').trim();
    const host = rawHost === '[::1]' ? '::1' : rawHost;
    if (host === '')
        throw new Error('http.host must be a non-empty string');
    const loopback = isLoopbackHost(host);
    const port = http.port ?? 8957;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`http.port must be an integer between 0 and 65535, got ${String(port)}`);
    }
    const authToken = (http.authToken ?? '').trim();
    if (!loopback && authToken === '') {
        throw new Error(`refusing to bind ${host} without http.authToken; bind 127.0.0.1 or set a token`);
    }
    const maxBodyBytes = positiveInt(http.maxBodyBytes, 1024 * 1024, 'http.maxBodyBytes');
    const agentInput = input.agent ?? {};
    const agent = {
        preset: nonEmpty(agentInput.preset, 'standard', 'agent.preset'),
        permissionPreset: (agentInput.permissionPreset ?? '').trim(),
        allowedPermissionPresets: stringList(agentInput.allowedPermissionPresets, 'agent.allowedPermissionPresets'),
        provider: (agentInput.provider ?? '').trim(),
        model: (agentInput.model ?? '').trim(),
        reasoningEffort: (agentInput.reasoningEffort ?? '').trim(),
        maxAgents: positiveInt(agentInput.maxAgents, 8, 'agent.maxAgents'),
        maxConcurrent: positiveInt(agentInput.maxConcurrent, 4, 'agent.maxConcurrent'),
        defaultTimeoutMs: positiveInt(agentInput.defaultTimeoutMs, 600_000, 'agent.defaultTimeoutMs'),
        defaultSyncWaitMs: nonNegativeInt(agentInput.defaultSyncWaitMs, 30_000, 'agent.defaultSyncWaitMs'),
        idleTtlMs: positiveInt(agentInput.idleTtlMs, 1_800_000, 'agent.idleTtlMs'),
        maxAnswerBytes: positiveInt(agentInput.maxAnswerBytes, 65_536, 'agent.maxAnswerBytes'),
    };
    if (agent.maxConcurrent > agent.maxAgents) {
        throw new Error('agent.maxConcurrent must not exceed agent.maxAgents');
    }
    const tasksInput = input.tasks ?? {};
    const tasks = {
        storePath: resolveStorePath(tasksInput.storePath),
        ttlMs: positiveInt(tasksInput.ttlMs, 604_800_000, 'tasks.ttlMs'),
        maxRetained: positiveInt(tasksInput.maxRetained, 1_000, 'tasks.maxRetained'),
        maxQueue: positiveInt(tasksInput.maxQueue, 100, 'tasks.maxQueue'),
    };
    const interactionsInput = input.interactions ?? {};
    const mode = interactionsInput.mode ?? (loopback ? 'remote' : 'deny');
    if (!INTERACTION_MODES.includes(mode)) {
        throw new Error(`interactions.mode must be one of ${INTERACTION_MODES.join(', ')}, got ${String(mode)}`);
    }
    if (!loopback && mode === 'remote' && authToken === '') {
        throw new Error('interactions.mode "remote" on a non-loopback bind requires http.authToken');
    }
    const interactions = {
        mode,
        approvalTimeoutMs: positiveInt(interactionsInput.approvalTimeoutMs, 300_000, 'interactions.approvalTimeoutMs'),
        questionTimeoutMs: positiveInt(interactionsInput.questionTimeoutMs, 300_000, 'interactions.questionTimeoutMs'),
        maxWaitMs: positiveInt(interactionsInput.maxWaitMs, 1_800_000, 'interactions.maxWaitMs'),
    };
    const workspaceRoots = input.workspaceRoots ?? [];
    if (!Array.isArray(workspaceRoots))
        throw new Error('workspaceRoots must be an array of absolute paths');
    for (const root of workspaceRoots) {
        if (typeof root !== 'string' || root.trim() === '' || !isAbsolute(root)) {
            throw new Error(`workspaceRoots entries must be absolute paths, got ${String(root)}`);
        }
    }
    const logLevel = input.logLevel ?? 'info';
    if (!LOG_LEVELS.includes(logLevel)) {
        throw new Error(`logLevel must be one of ${LOG_LEVELS.join(', ')}, got ${String(logLevel)}`);
    }
    const allowedOrigins = resolveOrigins(http.allowedOrigins, host, port);
    return {
        logLevel,
        workspaceRoots: [...workspaceRoots],
        http: {
            host,
            port,
            authToken,
            allowedOrigins,
            maxBodyBytes,
        },
        agent,
        tasks,
        interactions,
    };
}
function positiveInt(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved <= 0) {
        throw new Error(`${name} must be a positive integer, got ${String(resolved)}`);
    }
    return resolved;
}
function nonNegativeInt(value, fallback, name) {
    const resolved = value ?? fallback;
    if (!Number.isInteger(resolved) || resolved < 0) {
        throw new Error(`${name} must be a non-negative integer, got ${String(resolved)}`);
    }
    return resolved;
}
function nonEmpty(value, fallback, name) {
    const resolved = (value ?? fallback).trim();
    if (resolved === '')
        throw new Error(`${name} must be a non-empty string`);
    return resolved;
}
function resolveStorePath(raw) {
    if (raw === undefined || raw.trim() === '') {
        return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-task-delegation', 'tasks');
    }
    if (!isAbsolute(raw))
        throw new Error(`tasks.storePath must be an absolute path, got ${raw}`);
    return raw;
}
function resolveOrigins(input, host, port) {
    if (input === undefined)
        return defaultOrigins(host, port);
    if (!Array.isArray(input))
        throw new Error('http.allowedOrigins must be an array of origins');
    const origins = [];
    for (const origin of input) {
        if (typeof origin !== 'string' || origin.trim() === '') {
            throw new Error('http.allowedOrigins entries must be non-empty origin strings');
        }
        let parsed;
        try {
            parsed = new URL(origin);
        }
        catch {
            throw new Error(`http.allowedOrigins entry is not a valid origin: ${origin}`);
        }
        if (parsed.origin !== origin.replace(/\/$/, '')) {
            throw new Error(`http.allowedOrigins entries must be origins without paths: ${origin}`);
        }
        origins.push(parsed.origin);
    }
    return origins;
}
/** Default browser origins for a loopback listener. */
function defaultOrigins(host, port) {
    if (!isLoopbackHost(host))
        return [];
    const suffix = port === 0 ? '' : `:${port}`;
    const origins = [`http://127.0.0.1${suffix}`, `http://localhost${suffix}`];
    if (host === '::1')
        origins.push(`http://[::1]${suffix}`);
    return origins;
}
