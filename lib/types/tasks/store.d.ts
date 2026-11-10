import type { Logger } from '../logger.js';
import { type TaskRecord } from '../types.js';
/** One JSON file per task with serialized, atomic writes. */
export declare class TaskStore {
    private readonly directory;
    private readonly logger;
    private readonly writes;
    private closed;
    constructor(directory: string, logger: Logger);
    get path(): string;
    init(): Promise<void>;
    /** Load every valid task file. Corrupt files are quarantined, not fatal. */
    loadAll(): Promise<TaskRecord[]>;
    /** Persist one record. Writes for the same task are serialized. */
    save(record: TaskRecord): Promise<void>;
    remove(taskId: string): Promise<void>;
    /**
     * Delete expired terminal records and enforce the retained-record bound.
     * @returns removed task ids.
     */
    prune(records: readonly TaskRecord[], ttlMs: number, maxRetained: number, now?: number): Promise<string[]>;
    close(): Promise<void>;
    private fileFor;
}
