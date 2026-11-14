import type { Logger } from '../logger.js';
import type { InteractionMode } from '../config.js';
import type { AnswerItem, RunHooks } from './types.js';
interface EventContext {
    on?: (event: string, listener: (...args: never[]) => unknown) => unknown;
}
/**
 * Per-session routing bridge for DSH's approval and question waterfalls.
 * It only claims requests while a plugin task is driving the session.
 */
export declare class SessionInteractionBridge {
    readonly sessionId: string;
    private readonly mode;
    private readonly approvalTimeoutMs;
    private readonly questionTimeoutMs;
    private readonly logger;
    private currentTaskId;
    private hooks;
    private autoReview;
    private active;
    private registered;
    private readonly detachers;
    constructor(sessionId: string, mode: InteractionMode, approvalTimeoutMs: number, questionTimeoutMs: number, logger: Logger);
    get pendingRequestId(): string | undefined;
    beginTask(taskId: string, hooks: RunHooks, autoReview?: boolean): void;
    endTask(taskId: string): void;
    /** Register on an agent-scoped context. Safe to call once. */
    register(ctx: EventContext): void;
    /** Resolve the active approval/question. Returns false when nothing matched. */
    approve(outcome: 'allowed-once' | 'rejected'): boolean;
    /** Answer a pending question; kept separate to preserve the Promise type. */
    resolveQuestion(answers: readonly AnswerItem[]): boolean;
    cancelPending(): boolean;
    detach(): void;
    private listen;
    private handleApproval;
    private handleQuestion;
    private attachAbort;
    private removeAbort;
    private settle;
}
export {};
