/** Public task state shared by the MCP tools and the task manager. */
export function isTerminal(status) {
    return status === 'succeeded' || status === 'failed' || status === 'canceled' || status === 'interrupted';
}
export function isSettled(status) {
    return isTerminal(status) || status === 'waiting';
}
export function toTaskState(record, queue) {
    const state = { taskId: record.taskId, status: record.status };
    if (record.sessionId !== undefined)
        state.sessionId = record.sessionId;
    if (record.permissionPreset !== undefined)
        state.permissionPreset = record.permissionPreset;
    if (queue?.queuePosition !== undefined)
        state.queuePosition = queue.queuePosition;
    if (queue?.blockedBy !== undefined)
        state.blockedBy = queue.blockedBy;
    if (record.progress !== undefined)
        state.progress = record.progress;
    if (record.pending !== undefined)
        state.pending = record.pending;
    if (record.error !== undefined)
        state.error = record.error;
    return state;
}
export function previewOf(task, max = 120) {
    const clean = task.replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}
