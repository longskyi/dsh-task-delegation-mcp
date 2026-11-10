import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { DomainError } from '../errors.js';
import { SessionInteractionBridge } from './bridge.js';
/** DSH-backed implementation of the execution seam. */
export class DshTaskAdapter {
    ctx;
    config;
    logger;
    entries = new Map();
    activeRuns = new Map();
    reaper;
    closing = false;
    constructor(ctx, config, logger) {
        this.ctx = ctx;
        this.config = config;
        this.logger = logger;
        const interval = Math.max(1_000, Math.min(60_000, Math.floor(config.agent.idleTtlMs / 2)));
        this.reaper = setInterval(() => void this.reapIdle().catch((error) => this.logger.error('idle session reaping failed', { error })), interval);
        this.reaper.unref();
    }
    poolKey(record) {
        const { preset, provider, model, reasoningEffort } = this.config.agent;
        return [
            record.cwd,
            preset,
            provider === '' ? 'default' : provider,
            model === '' ? 'default' : model,
            reasoningEffort,
        ].join('\u0000');
    }
    async start(record, hooks) {
        if (this.closing)
            throw new DomainError('internal', 'plugin is shutting down');
        const allocation = await this.acquire(record, hooks);
        const { entry, fromSeq } = allocation;
        if (this.closing) {
            await this.disposeEntry(entry);
            throw new DomainError('internal', 'plugin is shutting down');
        }
        const bridge = entry.bridge;
        bridge.beginTask(record.taskId, hooks);
        try {
            await hooks.onSession(entry.sessionId, fromSeq);
        }
        catch (error) {
            bridge.endTask(record.taskId);
            await this.release(entry);
            throw error;
        }
        if (this.closing) {
            bridge.endTask(record.taskId);
            await this.release(entry);
            throw new DomainError('internal', 'plugin is shutting down');
        }
        let resolveResult;
        let rejectResult;
        const result = new Promise((resolve, reject) => {
            resolveResult = resolve;
            rejectResult = reject;
        });
        let cancelReason;
        let forcedDispose = false;
        const run = {
            taskId: record.taskId,
            result,
            cancel: async (reason) => {
                cancelReason ??= reason;
                bridge.cancelPending();
                try {
                    if (entry.agent.status === 'running')
                        entry.agent.cancel({ kind: 'user' });
                }
                catch (error) {
                    this.logger.warn('agent cancel failed', { taskId: record.taskId, error });
                }
            },
            forceDispose: async () => {
                forcedDispose = true;
                bridge.cancelPending();
                await this.disposeEntry(entry);
            },
        };
        this.activeRuns.set(record.taskId, run);
        queueMicrotask(() => {
            void this.execute(record, entry, fromSeq, bridge, hooks, () => cancelReason, () => forcedDispose)
                .then(resolveResult, rejectResult)
                .finally(() => {
                this.activeRuns.delete(record.taskId);
            });
        });
        return run;
    }
    async readTrace(record, fromSeq) {
        if (record.sessionId === undefined || record.fromSeq === undefined)
            return { unavailable: 'not_started' };
        const entry = this.entries.get(record.sessionId);
        if (entry !== undefined) {
            try {
                const to = record.toSeq ?? entry.agent.session.seq;
                return { events: [...entry.agent.session.snapshotEvents(fromSeq, to)], toSeq: to };
            }
            catch (error) {
                this.logger.warn('live trace read failed', { taskId: record.taskId, error });
            }
        }
        const persistence = getService(this.ctx, 'sessionPersistence');
        if (persistence === undefined)
            return { unavailable: 'session_gone' };
        let handle;
        try {
            handle = await persistence.open(record.sessionId, 'read');
            const length = record.toSeq === undefined ? undefined : Math.max(0, record.toSeq - fromSeq);
            if (length === 0)
                return { events: [], toSeq: fromSeq };
            const slice = await handle.read(fromSeq, length);
            const toSeq = record.toSeq ?? fromSeq + slice.events.length;
            if (toSeq <= fromSeq)
                return { events: [], toSeq };
            if (slice.events.length === 0)
                return { unavailable: 'compacted' };
            if (slice.events[0] !== undefined && slice.events[0].seq !== fromSeq) {
                return { unavailable: 'compacted' };
            }
            const last = slice.events.at(-1);
            if (record.toSeq !== undefined && (last === undefined || last.seq + 1 < record.toSeq)) {
                return { unavailable: 'compacted' };
            }
            return { events: [...slice.events], toSeq };
        }
        catch (error) {
            const name = error instanceof Error ? error.name : '';
            if (name.includes('NotFound'))
                return { unavailable: 'session_gone' };
            this.logger.warn('persisted trace read failed', { taskId: record.taskId, error });
            return { unavailable: 'session_gone' };
        }
        finally {
            await handle?.close().catch(() => undefined);
        }
    }
    health() {
        return { pooled: this.entries.size, active: this.activeRuns.size };
    }
    async close() {
        this.closing = true;
        clearInterval(this.reaper);
        for (const run of [...this.activeRuns.values()]) {
            await run.cancel('shutdown').catch(() => undefined);
        }
        for (const entry of [...this.entries.values()]) {
            await this.disposeEntry(entry);
        }
        this.entries.clear();
        this.activeRuns.clear();
    }
    async acquire(record, hooks) {
        if (record.sessionId !== undefined)
            return await this.acquireExplicit(record);
        const baseKey = this.poolKey(record);
        const key = record.sessionMode === 'fresh' ? `${baseKey}\u0000fresh:${record.taskId}` : baseKey;
        if (record.sessionMode === 'reuse') {
            const reusable = [...this.entries.values()]
                .filter((entry) => entry.key === key && entry.refs === 0 && !entry.disposeAfterTask && !entry.ephemeral)
                .sort((a, b) => b.lastUsed - a.lastUsed)[0];
            if (reusable !== undefined && this.ctx.agents.get(reusable.sessionId) === reusable.agent) {
                reusable.refs += 1;
                reusable.lastUsed = Date.now();
                reusable.bridge.beginTask(record.taskId, hooks);
                return { entry: reusable, fromSeq: reusable.agent.session.seq };
            }
            if (reusable !== undefined)
                await this.disposeEntry(reusable);
        }
        const entry = await this.createSession(record, key, record.sessionMode === 'fresh');
        return { entry, fromSeq: entry.agent.session.seq };
    }
    async acquireExplicit(record) {
        const sessionId = record.sessionId;
        const pooled = this.entries.get(sessionId);
        if (pooled !== undefined) {
            if (pooled.refs > 0)
                throw new DomainError('busy', `session ${sessionId} is already executing a task`);
            if (this.ctx.agents.get(sessionId) !== pooled.agent) {
                await this.disposeEntry(pooled);
            }
            else {
                await this.assertCwd(record, pooled.agent.session.header.cwd);
                pooled.refs += 1;
                pooled.lastUsed = Date.now();
                return { entry: pooled, fromSeq: pooled.agent.session.seq };
            }
        }
        const live = this.ctx.agents.get(sessionId);
        if (live !== undefined) {
            await this.assertCwd(record, live.session.header.cwd);
            const bridge = this.newBridge(sessionId);
            bridge.register(live.ctx ?? {});
            const entry = {
                sessionId,
                handle: { agent: live, dispose: async () => undefined },
                agent: live,
                key: `session:${sessionId}`,
                lastUsed: Date.now(),
                refs: 1,
                owned: false,
                disposeAfterTask: false,
                ephemeral: false,
                bridge,
            };
            this.entries.set(sessionId, entry);
            return { entry, fromSeq: live.session.seq };
        }
        const route = this.resolveAgentOptions();
        if (route === undefined) {
            throw new DomainError('agent_unavailable', 'no provider/model configured and no DSH default model is available');
        }
        const bridge = this.newBridge(sessionId);
        let handle;
        try {
            handle = await this.ctx.agents.resume({
                resumeSessionId: sessionId,
                agentOptions: route,
                setup: async (agentCtx) => {
                    bridge.register(agentCtx);
                    await this.mountPreset(agentCtx);
                },
            });
        }
        catch (error) {
            throw new DomainError('session_not_found', `session ${sessionId} is not live and could not be resumed`, {
                cause: error,
            });
        }
        try {
            await this.assertCwd(record, handle.agent.session.header.cwd);
        }
        catch (error) {
            await handle.dispose().catch(() => undefined);
            throw error;
        }
        const entry = {
            sessionId,
            handle,
            agent: handle.agent,
            key: `session:${sessionId}`,
            lastUsed: Date.now(),
            refs: 1,
            owned: true,
            disposeAfterTask: true,
            ephemeral: false,
            bridge,
        };
        this.entries.set(sessionId, entry);
        await this.afterCreate(entry, record.title);
        return { entry, fromSeq: handle.agent.session.seq };
    }
    async createSession(record, key, fresh) {
        if (!(await this.evictOneIfNeeded())) {
            throw new DomainError('busy', 'agent pool is full; wait for a running task to finish');
        }
        const route = this.resolveAgentOptions();
        if (route === undefined) {
            throw new DomainError('agent_unavailable', 'no provider/model configured and no DSH default model is available');
        }
        const sessionId = randomUUID();
        const bridge = this.newBridge(sessionId);
        let handle;
        try {
            handle = await this.ctx.agents.create({
                sessionId,
                meta: { cwd: record.cwd, agentPreset: this.config.agent.preset },
                agentOptions: route,
                setup: async (agentCtx) => {
                    bridge.register(agentCtx);
                    await this.mountPreset(agentCtx);
                },
            });
        }
        catch (error) {
            if (error instanceof DomainError)
                throw error;
            throw new DomainError('agent_unavailable', `could not create a DSH agent: ${messageOf(error)}`, {
                cause: error,
            });
        }
        const entry = {
            sessionId,
            handle,
            agent: handle.agent,
            key,
            lastUsed: Date.now(),
            refs: 1,
            owned: true,
            disposeAfterTask: fresh,
            ephemeral: fresh,
            bridge,
        };
        this.entries.set(sessionId, entry);
        await this.afterCreate(entry, record.title);
        return entry;
    }
    async execute(record, entry, fromSeq, bridge, hooks, cancelReason, forcedDispose) {
        let toSeq = fromSeq;
        let interval;
        try {
            if (cancelReason() !== undefined || forcedDispose()) {
                return {
                    status: 'canceled',
                    fromSeq,
                    toSeq,
                    error: { code: 'canceled', message: 'task canceled before the turn started' },
                };
            }
            entry.agent.followup(createUserMessage(buildPrompt(record)));
            let lastProgress = '';
            interval = setInterval(() => {
                try {
                    const progress = progressFrom(entry.agent.session.snapshotEvents(fromSeq));
                    if (progress !== undefined && progress !== lastProgress) {
                        lastProgress = progress;
                        hooks.onProgress(progress);
                    }
                }
                catch {
                    // A disposed session can throw; the run result is authoritative.
                }
            }, 750);
            interval.unref();
            await entry.agent.whenIdle();
            toSeq = entry.agent.session.seq;
            const events = entry.agent.session.snapshotEvents(fromSeq, toSeq);
            const analyzed = analyze(events, fromSeq, toSeq);
            if (forcedDispose()) {
                return {
                    status: 'canceled',
                    fromSeq,
                    toSeq,
                    error: { code: 'canceled', message: 'task canceled while the session was being disposed' },
                };
            }
            return analyzed;
        }
        catch (error) {
            toSeq = entry.agent.session.seq;
            if (cancelReason() !== undefined) {
                return {
                    status: 'canceled',
                    fromSeq,
                    toSeq,
                    error: { code: 'canceled', message: 'task canceled' },
                };
            }
            return {
                status: 'failed',
                fromSeq,
                toSeq,
                error: { code: 'agent_failed', message: messageOf(error) },
            };
        }
        finally {
            if (interval !== undefined)
                clearInterval(interval);
            await this.flush(entry).catch(() => undefined);
            bridge.endTask(record.taskId);
            await this.release(entry);
        }
    }
    async release(entry) {
        entry.refs = Math.max(0, entry.refs - 1);
        entry.lastUsed = Date.now();
        if (entry.disposeAfterTask || entry.ephemeral)
            await this.disposeEntry(entry);
    }
    async disposeEntry(entry) {
        if (this.entries.get(entry.sessionId) === entry)
            this.entries.delete(entry.sessionId);
        entry.bridge.detach();
        await this.flush(entry).catch(() => undefined);
        if (!entry.owned)
            return;
        try {
            await entry.handle.dispose();
        }
        catch (error) {
            this.logger.warn('agent dispose failed', { sessionId: entry.sessionId, error });
        }
    }
    async flush(entry) {
        const sessions = getService(this.ctx, 'sessions');
        await sessions?.flush?.(entry.agent.session);
    }
    async reapIdle() {
        if (this.closing)
            return;
        const cutoff = Date.now() - this.config.agent.idleTtlMs;
        for (const entry of [...this.entries.values()]) {
            if (entry.refs === 0 && entry.lastUsed < cutoff)
                await this.disposeEntry(entry);
        }
    }
    async evictOneIfNeeded() {
        if (this.entries.size < this.config.agent.maxAgents)
            return true;
        const idle = [...this.entries.values()]
            .filter((entry) => entry.refs === 0)
            .sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (idle === undefined)
            return false;
        await this.disposeEntry(idle);
        return true;
    }
    newBridge(sessionId) {
        return new SessionInteractionBridge(sessionId, this.config.interactions.mode, this.config.interactions.approvalTimeoutMs, this.config.interactions.questionTimeoutMs, this.logger);
    }
    resolveAgentOptions() {
        const agent = this.config.agent;
        if (agent.provider !== '' && agent.model !== '') {
            return {
                provider: agent.provider,
                model: agent.model,
                ...(agent.reasoningEffort === '' ? {} : { reasoningEffort: agent.reasoningEffort }),
            };
        }
        const selection = getService(this.ctx, 'agentDefaultModel')?.currentSelection?.();
        if (selection?.provider === undefined || selection.provider === '' || selection.model === undefined || selection.model === '')
            return undefined;
        return {
            provider: selection.provider,
            model: selection.model,
            ...(agent.reasoningEffort !== ''
                ? { reasoningEffort: agent.reasoningEffort }
                : selection.reasoningEffort === undefined
                    ? {}
                    : { reasoningEffort: selection.reasoningEffort }),
        };
    }
    async mountPreset(agentCtx) {
        const presets = this.ctx.agentPresets;
        if (presets === undefined)
            throw new Error('agentPresets service is unavailable');
        try {
            await presets.mount(agentCtx, this.config.agent.preset);
        }
        catch (error) {
            throw new Error(`could not mount agent preset "${this.config.agent.preset}": ${messageOf(error)}`);
        }
    }
    async assertCwd(record, headerCwd) {
        if (headerCwd === undefined)
            return;
        const canonical = await canonicalPath(headerCwd);
        if (canonical !== record.cwd) {
            throw new DomainError('cwd_mismatch', `session belongs to ${canonical}, not ${record.cwd}`, {
                expected: record.cwd,
                actual: canonical,
            });
        }
    }
    async afterCreate(entry, title) {
        if (title !== undefined) {
            try {
                getService(this.ctx, 'sessionTitle')?.rename?.(entry.agent.session, title);
            }
            catch (error) {
                this.logger.warn('session title set failed', { sessionId: entry.sessionId, error });
            }
        }
        try {
            const cwd = entry.agent.session.header.cwd;
            if (cwd === undefined)
                return;
            const registry = getService(this.ctx, 'workspaceRegistry');
            if (registry === undefined)
                return;
            const workspace = (await registry.resolveByPath?.(cwd)) ?? (await registry.create?.(cwd));
            await workspace?.attachSession?.(entry.sessionId);
        }
        catch (error) {
            this.logger.warn('workspace attach failed', { sessionId: entry.sessionId, error });
        }
    }
}
function createUserMessage(text) {
    return {
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:dsh-task-delegation' },
    };
}
function buildPrompt(record) {
    return [
        'You are the executing agent. Another agent delegated this task to you with context.',
        'You own the implementation and verification.',
        '',
        'Task:',
        record.task,
        ...(record.context.trim() === '' ? [] : ['', 'Context:', record.context]),
        '',
        'When done, reply with your final answer or report. It can be a single sentence or a',
        'complete document. If the report is long, write it to a file and include the path and a',
        'short conclusion. Do not wrap the final answer in JSON.',
    ].join('\n');
}
function analyze(events, fromSeq, toSeq) {
    let answer;
    let turnError;
    let aborted = false;
    for (const event of events) {
        if (event.type === 'assistant/message') {
            const text = assistantText(event.data);
            if (text.trim() !== '')
                answer = text;
        }
        else if (event.type === 'turn/end') {
            const reason = asRecord(asRecord(event.data)?.reason);
            turnError = undefined;
            aborted = false;
            if (reason?.kind === 'error') {
                const failure = asRecord(reason.error);
                turnError = stringOf(failure?.message) ?? 'agent turn failed';
            }
            else if (reason?.kind === 'aborted') {
                aborted = true;
            }
        }
    }
    if (aborted) {
        return {
            status: 'canceled',
            ...(answer === undefined ? {} : { answer }),
            fromSeq,
            toSeq,
            error: { code: 'canceled', message: 'task canceled' },
        };
    }
    if (turnError !== undefined) {
        return {
            status: 'failed',
            ...(answer === undefined ? {} : { answer }),
            fromSeq,
            toSeq,
            error: { code: 'agent_failed', message: turnError },
        };
    }
    return {
        status: 'succeeded',
        ...(answer === undefined ? {} : { answer }),
        fromSeq,
        toSeq,
    };
}
function assistantText(data) {
    const message = asRecord(asRecord(data)?.message);
    const content = message?.content;
    if (!Array.isArray(content))
        return '';
    const parts = [];
    for (const block of content) {
        const record = asRecord(block);
        if (record?.type === 'text' && typeof record.text === 'string' && record.text.trim() !== '') {
            parts.push(record.text);
        }
    }
    return parts.join('\n');
}
function progressFrom(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event === undefined)
            continue;
        if (event.type === 'assistant/message') {
            const text = assistantText(event.data);
            if (text.trim() !== '')
                return `assistant: ${oneLine(text, 160)}`;
            if (hasReasoning(event.data))
                return 'thinking';
        }
        else if (event.type === 'tool/call') {
            const data = asRecord(event.data);
            const name = stringOf(data?.name) ?? '?';
            const args = stringOf(data?.arguments) ?? '';
            return `tool ${name}: ${oneLine(args, 120)}`;
        }
    }
    return undefined;
}
function hasReasoning(data) {
    const content = asRecord(asRecord(data)?.message)?.content;
    return Array.isArray(content) && content.some((block) => asRecord(block)?.type === 'reasoning');
}
function oneLine(text, max) {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function stringOf(value) {
    return typeof value === 'string' ? value : undefined;
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function getService(ctx, name) {
    try {
        return ctx.get?.(name);
    }
    catch {
        return undefined;
    }
}
async function canonicalPath(path) {
    try {
        return await realpath(path);
    }
    catch {
        return path;
    }
}
