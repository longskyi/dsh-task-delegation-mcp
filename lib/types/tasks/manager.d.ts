import type { ResolvedConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { AnswerItem, TaskAdapter } from '../agents/types.js';
import type { TaskRecord, TaskState, TaskStatus, TaskSummary, TraceInclude, TraceState, WaitInfo } from '../types.js';
import { TaskStore } from './store.js';
export interface SubmitInput {
    task: string;
    context?: string;
    cwd?: string;
    sessionId?: string;
    sessionMode?: 'reuse' | 'fresh';
    title?: string;
}
export interface WaitOptions {
    timeoutMs?: number;
}
export interface WaitOutcome extends WaitInfo {
    record: TaskRecord;
}
export interface TraceOptions {
    afterSeq?: number;
    limit?: number;
    include?: readonly TraceInclude[];
    maxBytes?: number;
}
export interface TraceResult {
    content: string;
    state: TraceState;
}
export interface CancelResult {
    record: TaskRecord;
    already: boolean;
}
/** Owns the task state machine, queue, sessions, interactions, and persistence. */
export declare class TaskManager {
    private readonly adapter;
    private readonly store;
    private readonly config;
    private readonly logger;
    private readonly records;
    private readonly runtimes;
    private readonly queue;
    private readonly running;
    private readonly locks;
    private readonly sessionLocks;
    private readonly waiters;
    private readonly roots;
    private pumping;
    private closed;
    private pruneTimer?;
    constructor(adapter: TaskAdapter, store: TaskStore, config: ResolvedConfig, logger: Logger);
    init(): Promise<void>;
    submit(input: SubmitInput): Promise<TaskRecord>;
    get(taskId: string): TaskRecord;
    stateOf(taskId: string): TaskState;
    wait(taskId: string, options?: WaitOptions): Promise<TaskRecord>;
    waitOutcome(taskId: string, options?: WaitOptions): Promise<WaitOutcome>;
    cancel(taskId: string): Promise<CancelResult>;
    approve(taskId: string, requestId: string, decision: 'allow-once' | 'reject'): Promise<{
        record: TaskRecord;
        already: boolean;
    }>;
    answer(taskId: string, requestId: string, answers: readonly AnswerItem[]): Promise<{
        record: TaskRecord;
        already: boolean;
    }>;
    trace(taskId: string, options: TraceOptions): Promise<TraceResult>;
    list(filter?: {
        status?: TaskStatus;
        cwd?: string;
        limit?: number;
    }): TaskRecord[];
    summaries(records: readonly TaskRecord[]): TaskSummary[];
    queueInfo(taskId: string): {
        queuePosition?: number;
        blockedBy?: string;
    };
    counts(): {
        queued: number;
        running: number;
        waiting: number;
    };
    health(): {
        queue: {
            queued: number;
            running: number;
            waiting: number;
        };
        agents: {
            pooled: number;
            active: number;
        };
    };
    close(): Promise<void>;
    private runTask;
    private finish;
    private onPending;
    private expirePending;
    private timeoutTask;
    private onUnavailable;
    private graceFinalize;
    private clearPending;
    private awaitRun;
    private pump;
    private isLocked;
    private lockHolder;
    private sameLock;
    private refreshQueue;
    private prune;
    private saveBestEffort;
    private saveInBackground;
    private save;
    private notify;
    private requireTask;
    private runtimeFor;
    private lockKeyFor;
    private newTaskId;
    private resolveCwd;
    private finishForced;
    private knownEndSeq;
    private currentSeq;
    private error;
    private auditDecision;
    private audit;
}
