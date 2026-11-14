import { previewOf, toTaskState } from '../types.js';
/** Agent-facing content for one task state. */
export function contentForRecord(record, queue = {}, wait) {
    switch (record.status) {
        case 'succeeded':
            return record.answer !== undefined && record.answer !== ''
                ? record.answer
                : `Task ${record.taskId} completed without a final message. Call dsh_task_trace for the execution history.`;
        case 'waiting':
            return waitingContent(record);
        case 'queued': {
            const behind = queue.blockedBy === undefined ? '' : ` behind ${queue.blockedBy}`;
            const position = queue.queuePosition === undefined ? '' : ` (position ${queue.queuePosition})`;
            const note = timeoutNote(wait);
            return `Task ${record.taskId} is queued${behind}${position}.${note} Call dsh_task_wait or dsh_task_get.`;
        }
        case 'running': {
            const progress = record.progress === undefined ? 'starting' : record.progress;
            const note = timeoutNote(wait);
            return `Task ${record.taskId} is still running: ${progress}.${note} Call dsh_task_wait again.`;
        }
        case 'failed': {
            const message = (record.error?.message ?? 'the agent reported a failure').replace(/[.!?]+$/, '');
            return `Task ${record.taskId} failed: ${message}. Call dsh_task_trace for the execution history.`;
        }
        case 'canceled':
            return `Task ${record.taskId} canceled.`;
        case 'interrupted':
            return `Task ${record.taskId} was interrupted by a DSH restart and will not resume. Call dsh_task_trace for the execution history.`;
    }
}
/** Minimal machine state. Successful answers are never duplicated here. */
export function stateForRecord(record, queue = {}) {
    if (record.status === 'succeeded') {
        return {
            taskId: record.taskId,
            status: record.status,
            ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
        };
    }
    return toTaskState(record, queue);
}
export function success(record, queue = {}, wait) {
    return {
        content: [{ type: 'text', text: contentForRecord(record, queue, wait) }],
        structuredContent: stateForRecord(record, queue),
    };
}
function timeoutNote(wait) {
    if (wait?.timedOut !== true)
        return '';
    const capped = wait.capped
        ? ` (requested ${wait.requestedTimeoutMs} ms; capped by interactions.maxWaitMs=${wait.maxWaitMs})`
        : '';
    return ` Wait timed out after ${wait.effectiveTimeoutMs} ms${capped}.`;
}
/** Map every domain error to a visible hint plus a small machine payload. */
export function failure(error) {
    const hint = errorHint(error);
    return {
        isError: true,
        content: [{ type: 'text', text: hint }],
        structuredContent: {
            error: {
                code: error.code,
                message: error.message,
                ...(error.expected === undefined ? {} : { expected: error.expected }),
                ...(error.actual === undefined ? {} : { actual: error.actual }),
            },
            ...(error.state === undefined ? {} : { state: error.state }),
        },
    };
}
function waitingContent(record) {
    const pending = record.pending;
    if (pending === undefined)
        return `Task ${record.taskId} is waiting. Call dsh_task_get.`;
    const expires = `expires at ${pending.expiresAt}`;
    if (pending.kind === 'approval') {
        const reason = pending.reason === undefined ? '' : ` — ${pending.reason}`;
        return (`Task ${record.taskId} is waiting for approval (requestId ${pending.requestId}): ` +
            `${pending.toolName}${reason} (${expires}).\n` +
            'Call dsh_task_approve with decision "allow-once" or "reject".');
    }
    return (`Task ${record.taskId} is waiting for an answer (requestId ${pending.requestId}, ` +
        `${pending.questions.length} question${pending.questions.length === 1 ? '' : 's'}, ${expires}).\n` +
        'Call dsh_task_answer with one answers[] item per question.');
}
function errorHint(error) {
    const message = error.message;
    if (message.includes('Call ') || message.includes('Check the id')) {
        return endsWithPeriod(message) ? message : `${message}.`;
    }
    const clean = message.replace(/[.!?]+$/, '');
    switch (error.code) {
        case 'task_not_found':
            return 'Task was not found. Check the id or call dsh_task_list.';
        case 'task_terminal':
            return `${clean}. Call dsh_task_get for the result.`;
        case 'task_not_waiting':
            return `${clean}. Call dsh_task_get.`;
        case 'interaction_expired':
            return `${clean}. Call dsh_task_get; do not reuse this requestId.`;
        case 'interaction_kind_mismatch':
        case 'interaction_not_found':
            return `${clean}. Call dsh_task_get for the current requestId.`;
        case 'answer_invalid':
            return `${clean}. The pending request is still valid.`;
        case 'busy':
            return `${clean}. Wait for a running task to finish, or cancel one with dsh_task_cancel.`;
        case 'cwd_not_found':
            return `${clean}. Pass an existing absolute directory.`;
        case 'cwd_forbidden':
            return `${clean}. Use a cwd under an allowed workspace root.`;
        case 'cwd_mismatch':
            return `${clean}. Pass that cwd or omit sessionId.`;
        case 'session_not_found':
            return `${clean}. Omit sessionId to create/reuse a session, or check the id.`;
        case 'agent_unavailable':
            return `${clean}. Configure agent.provider/agent.model or DSH's default model, then retry.`;
        case 'permission_denied':
            return `${clean}. Omit permissionPreset or use one allowed by agent.allowedPermissionPresets.`;
        case 'permission_unavailable':
            return `${clean}. Enable that DSH permission preset (and Auto review for "auto"), or omit permissionPreset.`;
        case 'approval_required':
            return `${clean}. Ask the operator to enable remote approval; this task cannot proceed.`;
        case 'question_unavailable':
            return `${clean}. Ask the operator; this task cannot proceed.`;
        case 'approval_timeout':
        case 'question_timeout':
            return `${clean}. Call dsh_task_get for the final state.`;
        case 'trace_unavailable':
            return `${clean}. Call dsh_task_get for the result, or dsh_task_wait if it is still running.`;
        case 'invalid_request':
            return `${clean}.`;
        case 'internal':
            return `${clean}. Retry once; if it persists, inspect the DSH log.`;
    }
}
function endsWithPeriod(text) {
    return text.endsWith('.') || text.endsWith('!') || text.endsWith('?');
}
export function listContent(records, summaries) {
    if (records.length === 0)
        return 'No matching tasks.';
    return summaries
        .map((summary, index) => {
        const record = records[index];
        const age = record === undefined ? '' : relativeAge(record.createdAt);
        const pending = summary.pendingKind === undefined ? '' : ` (${summary.pendingKind})`;
        return `${summary.taskId}  ${summary.status}  ${age}  ${previewOf(summary.preview, 80)}${pending}`;
    })
        .join('\n');
}
function relativeAge(iso) {
    const then = Date.parse(iso);
    if (!Number.isFinite(then))
        return '';
    const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (seconds < 60)
        return `~${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `~${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `~${hours}h ago`;
    return `~${Math.floor(hours / 24)}d ago`;
}
