import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isTerminal } from '../types.js';
/** One JSON file per task with serialized, atomic writes. */
export class TaskStore {
    directory;
    logger;
    writes = new Map();
    closed = false;
    constructor(directory, logger) {
        this.directory = directory;
        this.logger = logger;
    }
    get path() {
        return this.directory;
    }
    async init() {
        await mkdir(this.directory, { recursive: true });
    }
    /** Load every valid task file. Corrupt files are quarantined, not fatal. */
    async loadAll() {
        const names = await readdir(this.directory);
        const records = [];
        for (const name of names) {
            if (!name.endsWith('.json') || name.startsWith('.'))
                continue;
            const file = join(this.directory, name);
            try {
                const parsed = JSON.parse(await readFile(file, 'utf8'));
                const record = validateRecord(parsed);
                if (record === undefined)
                    throw new Error('not a task record');
                records.push(record);
            }
            catch (error) {
                const quarantine = `${file}.corrupt-${Date.now()}`;
                this.logger.warn('quarantining unreadable task file', { file, quarantine, error });
                await rename(file, quarantine).catch(() => undefined);
            }
        }
        records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return records;
    }
    /** Persist one record. Writes for the same task are serialized. */
    save(record) {
        if (this.closed)
            return Promise.reject(new Error('task store is closed'));
        const previous = this.writes.get(record.taskId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(async () => {
            await mkdir(this.directory, { recursive: true });
            const target = this.fileFor(record.taskId);
            const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
            const payload = `${JSON.stringify(record, null, 2)}\n`;
            try {
                await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
                await rename(temporary, target);
            }
            catch (error) {
                await rm(temporary, { force: true }).catch(() => undefined);
                throw error;
            }
        });
        this.writes.set(record.taskId, next);
        void next.finally(() => {
            if (this.writes.get(record.taskId) === next)
                this.writes.delete(record.taskId);
        }).catch(() => undefined);
        return next;
    }
    async remove(taskId) {
        await this.writes.get(taskId)?.catch(() => undefined);
        await rm(this.fileFor(taskId), { force: true });
    }
    /**
     * Delete expired terminal records and enforce the retained-record bound.
     * @returns removed task ids.
     */
    async prune(records, ttlMs, maxRetained, now = Date.now()) {
        const ordered = [...records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const removed = [];
        let retained = 0;
        for (const record of ordered) {
            if (!isTerminal(record.status))
                continue;
            retained += 1;
            const finished = record.finishedAt === undefined ? undefined : Date.parse(record.finishedAt);
            const expired = finished !== undefined && Number.isFinite(finished) && now - finished > ttlMs;
            if (expired || retained > maxRetained) {
                await this.remove(record.taskId);
                removed.push(record.taskId);
            }
        }
        return removed;
    }
    async close() {
        this.closed = true;
        await Promise.allSettled([...this.writes.values()]);
        this.writes.clear();
    }
    fileFor(taskId) {
        if (!/^t_[A-Za-z0-9-]+$/.test(taskId))
            throw new Error(`invalid task id: ${taskId}`);
        return join(this.directory, `${taskId}.json`);
    }
}
function validateRecord(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const record = value;
    if (typeof record.taskId !== 'string' || !/^t_[A-Za-z0-9-]+$/.test(record.taskId))
        return undefined;
    if (typeof record.task !== 'string' || typeof record.context !== 'string')
        return undefined;
    if (typeof record.cwd !== 'string' || typeof record.createdAt !== 'string')
        return undefined;
    if (record.sessionMode !== 'reuse' && record.sessionMode !== 'fresh')
        return undefined;
    if (typeof record.preset !== 'string')
        return undefined;
    if (record.status !== 'queued' &&
        record.status !== 'running' &&
        record.status !== 'waiting' &&
        record.status !== 'succeeded' &&
        record.status !== 'failed' &&
        record.status !== 'canceled' &&
        record.status !== 'interrupted') {
        return undefined;
    }
    return record;
}
