import type { TaskState } from './types.js';
/** Stable domain error codes exposed in tool results. */
export type ErrorCode = 'invalid_request' | 'task_not_found' | 'task_not_waiting' | 'task_terminal' | 'interaction_not_found' | 'interaction_kind_mismatch' | 'interaction_expired' | 'answer_invalid' | 'busy' | 'cwd_not_found' | 'cwd_forbidden' | 'cwd_mismatch' | 'session_not_found' | 'agent_unavailable' | 'approval_required' | 'question_unavailable' | 'approval_timeout' | 'question_timeout' | 'trace_unavailable' | 'internal';
export interface DomainErrorOptions {
    expected?: string;
    actual?: string;
    state?: TaskState;
    cause?: unknown;
}
/** A failure that maps to the documented MCP error envelope. */
export declare class DomainError extends Error {
    readonly code: ErrorCode;
    readonly expected?: string;
    readonly actual?: string;
    readonly state?: TaskState;
    constructor(code: ErrorCode, message: string, options?: DomainErrorOptions);
}
export declare function isDomainError(error: unknown): error is DomainError;
export declare function asDomainError(error: unknown): DomainError;
