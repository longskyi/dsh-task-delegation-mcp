/** Plugin configuration: input shape, defaults, and validation. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type InteractionMode = 'remote' | 'deny' | 'host';
export interface HttpConfig {
    /** Bind address. Defaults to 127.0.0.1. */
    host: string;
    /** MCP/HTTP port. Defaults to 8957. Use 0 for an ephemeral port in tests. */
    port: number;
    /** Bearer token required on every /mcp request. Empty disables auth. */
    authToken: string;
    /** Browser Origin values accepted on /mcp. */
    allowedOrigins: string[];
    /** Maximum accepted Content-Length for an MCP request. */
    maxBodyBytes: number;
}
export interface AgentConfig {
    /** DSH agent preset mounted for delegated sessions. */
    preset: string;
    /** Provider override; empty follows DSH's default model selection. */
    provider: string;
    /** Model override; empty follows DSH's default model selection. */
    model: string;
    /** Reasoning effort override; empty follows the provider/model default. */
    reasoningEffort: string;
    /** Maximum pooled sessions. */
    maxAgents: number;
    /** Maximum tasks running (including waiting) at once. */
    maxConcurrent: number;
    /** Maximum wall-clock time for one task. */
    defaultTimeoutMs: number;
    /** Default wait used by dsh_agent_run and dsh_task_wait. */
    defaultSyncWaitMs: number;
    /** Idle pooled sessions are disposed after this long. */
    idleTtlMs: number;
    /** Maximum final-answer bytes returned by a tool. */
    maxAnswerBytes: number;
}
export interface TaskConfig {
    /** Directory holding one JSON file per task. */
    storePath: string;
    /** Finished tasks older than this are pruned. */
    ttlMs: number;
    /** Maximum retained task records. */
    maxRetained: number;
    /** Maximum queued tasks. */
    maxQueue: number;
}
export interface InteractionsConfig {
    mode: InteractionMode;
    approvalTimeoutMs: number;
    questionTimeoutMs: number;
    maxWaitMs: number;
}
export interface Config {
    http?: Partial<HttpConfig>;
    agent?: Partial<AgentConfig>;
    tasks?: Partial<TaskConfig>;
    interactions?: Partial<InteractionsConfig>;
    /** Optional allowlist. Canonicalized at startup; a missing root is an error. */
    workspaceRoots?: string[];
    logLevel?: LogLevel;
}
export interface ResolvedConfig {
    http: HttpConfig;
    agent: AgentConfig;
    tasks: TaskConfig;
    interactions: InteractionsConfig;
    workspaceRoots: string[];
    logLevel: LogLevel;
}
/** Whether `host` only accepts local connections. */
export declare function isLoopbackHost(host: string): boolean;
/**
 * Apply defaults and validate the plugin configuration.
 * @throws when a port, body limit, log level, workspace root, or non-loopback
 *   binding is unsafe.
 */
export declare function resolveConfig(input?: Config): ResolvedConfig;
