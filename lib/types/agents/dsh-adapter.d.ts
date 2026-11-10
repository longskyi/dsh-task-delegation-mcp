import type { ResolvedConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { TaskRecord } from '../types.js';
import type { AgentRun, RunHooks, TaskAdapter, TraceRead } from './types.js';
interface DshSession {
    id: string;
    header: {
        cwd?: string;
    };
    seq: number;
    snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly DshEvent[];
}
interface DshEvent {
    seq: number;
    type: string;
    data?: unknown;
}
interface DshAgent {
    id: string;
    session: DshSession;
    ctx?: EventContext;
    status?: 'idle' | 'running';
    followup(message: DshUserMessage): void;
    whenIdle(): Promise<void>;
    cancel(cause: {
        kind: 'user' | 'disposed';
    }): void;
}
interface DshUserMessage {
    id: string;
    role: 'user';
    content: {
        type: 'text';
        text: string;
    }[];
    source: {
        kind: 'plugin:dsh-task-delegation';
    };
}
interface DshHandle {
    agent: DshAgent;
    dispose(): Promise<void>;
}
interface DshAgentCreateOptions {
    sessionId: string;
    meta: {
        cwd: string;
        agentPreset: string;
    };
    agentOptions: Record<string, unknown>;
    setup: (agentCtx: EventContext) => Promise<void>;
}
interface DshAgentResumeOptions {
    resumeSessionId: string;
    agentOptions: Record<string, unknown>;
    setup: (agentCtx: EventContext) => Promise<void>;
}
interface EventContext {
    on?: (event: string, listener: (...args: never[]) => unknown) => unknown;
}
interface DshContext {
    agents: {
        create(options: DshAgentCreateOptions): Promise<DshHandle>;
        resume(options: DshAgentResumeOptions): Promise<DshHandle>;
        get(id: string): DshAgent | undefined;
    };
    agentPresets?: {
        mount(agentCtx: EventContext, preset: string): Promise<unknown>;
    };
    get?: (name: string) => unknown;
}
/** DSH-backed implementation of the execution seam. */
export declare class DshTaskAdapter implements TaskAdapter {
    private readonly ctx;
    private readonly config;
    private readonly logger;
    private readonly entries;
    private readonly activeRuns;
    private readonly reaper;
    private closing;
    constructor(ctx: DshContext, config: ResolvedConfig, logger: Logger);
    poolKey(record: TaskRecord): string;
    start(record: TaskRecord, hooks: RunHooks): Promise<AgentRun>;
    readTrace(record: TaskRecord, fromSeq: number): Promise<TraceRead>;
    health(): {
        pooled: number;
        active: number;
    };
    close(): Promise<void>;
    private acquire;
    private acquireExplicit;
    private createSession;
    private execute;
    private release;
    private disposeEntry;
    private flush;
    private reapIdle;
    private evictOneIfNeeded;
    private newBridge;
    private resolveAgentOptions;
    private mountPreset;
    private assertCwd;
    private afterCreate;
}
export {};
