import { randomUUID } from 'node:crypto';
/**
 * Per-session routing bridge for DSH's approval and question waterfalls.
 * It only claims requests while a plugin task is driving the session.
 */
export class SessionInteractionBridge {
    sessionId;
    mode;
    approvalTimeoutMs;
    questionTimeoutMs;
    logger;
    currentTaskId;
    hooks;
    autoReview = false;
    active;
    registered = false;
    detachers = [];
    constructor(sessionId, mode, approvalTimeoutMs, questionTimeoutMs, logger) {
        this.sessionId = sessionId;
        this.mode = mode;
        this.approvalTimeoutMs = approvalTimeoutMs;
        this.questionTimeoutMs = questionTimeoutMs;
        this.logger = logger;
    }
    get pendingRequestId() {
        return this.active?.requestId;
    }
    beginTask(taskId, hooks, autoReview = false) {
        if (this.currentTaskId !== undefined && this.currentTaskId !== taskId) {
            this.cancelPending();
        }
        this.currentTaskId = taskId;
        this.hooks = hooks;
        this.autoReview = autoReview;
    }
    endTask(taskId) {
        if (this.currentTaskId !== taskId)
            return;
        this.cancelPending();
        this.currentTaskId = undefined;
        this.hooks = undefined;
        this.autoReview = false;
    }
    /** Register on an agent-scoped context. Safe to call once. */
    register(ctx) {
        if (this.registered)
            return;
        this.registered = true;
        if (typeof ctx.on !== 'function') {
            this.logger.warn('agent context has no event API; interactions will fail closed', {
                sessionId: this.sessionId,
            });
            return;
        }
        this.listen(ctx, 'approval/request', (request, next) => this.handleApproval(request, next));
        this.listen(ctx, 'user-questions/request', (request, next) => this.handleQuestion(request, next));
    }
    /** Resolve the active approval/question. Returns false when nothing matched. */
    approve(outcome) {
        const active = this.active;
        if (active === undefined || active.kind !== 'approval' || active.resolveApproval === undefined)
            return false;
        this.settle(active);
        active.resolveApproval(outcome);
        return true;
    }
    /** Answer a pending question; kept separate to preserve the Promise type. */
    resolveQuestion(answers) {
        const active = this.active;
        if (active === undefined || active.kind !== 'question' || active.resolveQuestion === undefined)
            return false;
        const resolve = active.resolveQuestion;
        this.settle(active);
        resolve({
            answers: answers.map((answer) => ({
                id: answer.questionId,
                selected: [...answer.selected],
                ...(answer.custom === undefined ? {} : { custom: answer.custom }),
            })),
        });
        return true;
    }
    cancelPending() {
        const active = this.active;
        if (active === undefined)
            return false;
        this.settle(active);
        if (active.resolveApproval !== undefined) {
            active.resolveApproval('cancelled');
        }
        else {
            active.rejectQuestion?.(new Error('interaction canceled'));
        }
        return true;
    }
    detach() {
        this.cancelPending();
        for (const detach of this.detachers.splice(0)) {
            try {
                detach();
            }
            catch {
                // The owning context may already be unwound.
            }
        }
        this.registered = false;
    }
    listen(ctx, event, handler) {
        const result = ctx.on?.(event, handler);
        if (typeof result === 'function')
            this.detachers.push(result);
    }
    async handleApproval(request, next) {
        const taskId = this.currentTaskId;
        const hooks = this.hooks;
        if (taskId === undefined || hooks === undefined)
            return next();
        if (this.active !== undefined) {
            this.logger.warn('approval requested while another interaction is pending', { sessionId: this.sessionId, taskId });
            return 'unavailable';
        }
        if (this.mode === 'deny') {
            hooks.onUnavailable('approval', 'approval is required but interactions.mode is "deny"');
            return 'unavailable';
        }
        // Auto review is the guardrail for full access. Never hand its denials to
        // the remote caller, who could otherwise override the reviewer. Delegate to
        // later host answerers; with no answerer the approval fails closed.
        if (this.autoReview)
            return await next();
        if (this.mode === 'host') {
            const outcome = await next();
            if (outcome === 'unavailable') {
                hooks.onUnavailable('approval', 'no host answerer claimed the approval request');
            }
            return outcome;
        }
        const requestId = `a_${randomUUID()}`;
        const expiresAt = new Date(Date.now() + this.approvalTimeoutMs).toISOString();
        const pending = {
            kind: 'approval',
            requestId,
            toolName: request.toolName ?? 'unknown',
            ...(request.reason === undefined ? {} : { reason: request.reason }),
            expiresAt,
        };
        return await new Promise((resolve) => {
            const active = {
                requestId,
                kind: 'approval',
                taskId,
                ...(request.signal === undefined ? {} : { signal: request.signal }),
                resolveApproval: resolve,
            };
            this.attachAbort(active, () => {
                this.settle(active);
                resolve('cancelled');
            });
            this.active = active;
            const responder = {
                kind: 'approval',
                approve: (outcome) => this.approve(outcome),
                answer: () => undefined,
                cancel: () => this.cancelPending(),
            };
            try {
                hooks.onPending(pending, responder);
            }
            catch (error) {
                this.active = undefined;
                this.removeAbort(active);
                this.logger.warn('approval could not be registered', { sessionId: this.sessionId, error });
                resolve('unavailable');
            }
        });
    }
    async handleQuestion(request, next) {
        const taskId = this.currentTaskId;
        const hooks = this.hooks;
        if (taskId === undefined || hooks === undefined)
            return next();
        if (this.active !== undefined)
            throw new Error('another interaction is already pending');
        if (this.mode === 'deny') {
            hooks.onUnavailable('question', 'a user question is required but interactions.mode is "deny"');
            throw new Error('user questions are unavailable');
        }
        if (this.mode === 'host') {
            try {
                return await next();
            }
            catch (error) {
                hooks.onUnavailable('question', error instanceof Error ? error.message : String(error));
                throw error;
            }
        }
        const requestId = `q_${randomUUID()}`;
        const expiresAt = new Date(Date.now() + this.questionTimeoutMs).toISOString();
        const questions = (request.questions ?? []).map((question) => ({
            id: question.id,
            question: question.question,
            ...(question.options === undefined
                ? {}
                : {
                    options: question.options.map((option) => ({
                        label: option.label,
                        ...(option.description === undefined ? {} : { description: option.description }),
                    })),
                }),
            ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
        }));
        const pending = { kind: 'question', requestId, questions, expiresAt };
        return await new Promise((resolve, reject) => {
            const active = {
                requestId,
                kind: 'question',
                taskId,
                ...(request.signal === undefined ? {} : { signal: request.signal }),
                resolveQuestion: resolve,
                rejectQuestion: reject,
            };
            this.attachAbort(active, () => {
                this.settle(active);
                reject(new Error('question canceled'));
            });
            this.active = active;
            const responder = {
                kind: 'question',
                approve: () => undefined,
                answer: (answers) => {
                    this.resolveQuestion(answers);
                },
                cancel: () => this.cancelPending(),
            };
            try {
                hooks.onPending(pending, responder);
            }
            catch (error) {
                this.active = undefined;
                this.removeAbort(active);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    attachAbort(active, onAbort) {
        if (active.signal === undefined)
            return;
        if (active.signal.aborted) {
            queueMicrotask(onAbort);
            return;
        }
        active.abort = onAbort;
        active.signal.addEventListener('abort', onAbort, { once: true });
    }
    removeAbort(active) {
        if (active.signal !== undefined && active.abort !== undefined) {
            active.signal.removeEventListener('abort', active.abort);
        }
    }
    settle(active) {
        if (this.active !== active)
            return;
        this.active = undefined;
        this.removeAbort(active);
        this.hooks?.onSettled(active.requestId);
    }
}
