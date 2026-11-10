import type { DomainError } from '../errors.js';
import type { TaskRecord, TaskState, TaskSummary } from '../types.js';
export interface QueueInfo {
    queuePosition?: number;
    blockedBy?: string;
}
export interface ToolSuccess {
    [key: string]: unknown;
    content: {
        type: 'text';
        text: string;
    }[];
    structuredContent: Record<string, unknown>;
}
export interface ToolErrorResult {
    [key: string]: unknown;
    isError: true;
    content: {
        type: 'text';
        text: string;
    }[];
    structuredContent: {
        error: {
            code: string;
            message: string;
            expected?: string;
            actual?: string;
        };
        state?: TaskState;
    };
}
/** Agent-facing content for one task state. */
export declare function contentForRecord(record: TaskRecord, queue?: QueueInfo): string;
/** Minimal machine state. Successful answers are never duplicated here. */
export declare function stateForRecord(record: TaskRecord, queue?: QueueInfo): Record<string, unknown>;
export declare function success(record: TaskRecord, queue?: QueueInfo): ToolSuccess;
/** Map every domain error to a visible hint plus a small machine payload. */
export declare function failure(error: DomainError): ToolErrorResult;
export declare function listContent(records: readonly TaskRecord[], summaries: readonly TaskSummary[]): string;
