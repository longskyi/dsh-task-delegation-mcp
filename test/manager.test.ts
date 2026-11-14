import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../src/logger.js'
import { resolveConfig } from '../src/config.js'
import { TaskManager } from '../src/tasks/manager.js'
import { TaskStore } from '../src/tasks/store.js'
import type { TaskRecord } from '../src/types.js'
import { FakeAdapter } from './helpers/fake-adapter.js'
import { createHarness, type TestHarness } from './helpers/manager.js'

let harness: TestHarness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(config = {}): Promise<TestHarness> {
  harness = await createHarness(config)
  return harness
}

describe('task manager', () => {
  it('submits, starts, and returns the final answer verbatim', async () => {
    const h = await setup()
    const record = await h.manager.submit({ task: 'say hello' })
    expect(['queued', 'running']).toContain(record.status)
    const run = await h.adapter.waitForRun(record.taskId)
    expect(h.manager.stateOf(record.taskId).sessionId).toBe(`s_${record.taskId}`)
    run.succeed('# Report\n\nAll good.')
    const finished = await h.manager.wait(record.taskId, { timeoutMs: 1_000 })
    expect(finished.status).toBe('succeeded')
    expect(finished.answer).toBe('# Report\n\nAll good.')
    expect(h.manager.stateOf(record.taskId)).toEqual({
      taskId: record.taskId,
      status: 'succeeded',
      sessionId: `s_${record.taskId}`,
    })
  })

  it('returns a running snapshot instead of blocking forever', async () => {
    const h = await setup({ agent: { maxAgents: 4, maxConcurrent: 2, defaultTimeoutMs: 10_000, defaultSyncWaitMs: 10 } })
    const record = await h.manager.submit({ task: 'slow' })
    await h.adapter.waitForRun(record.taskId)
    const snapshot = await h.manager.wait(record.taskId, { timeoutMs: 10 })
    expect(snapshot.status).toBe('running')
  })

  it('reports a capped wait and its effective timeout', async () => {
    const h = await setup({
      agent: { defaultSyncWaitMs: 10 },
      interactions: { maxWaitMs: 20 },
    })
    const record = await h.manager.submit({ task: 'slow' })
    await h.adapter.waitForRun(record.taskId)
    const outcome = await h.manager.waitOutcome(record.taskId, { timeoutMs: 300_000 })
    expect(outcome.record.status).toBe('running')
    expect(outcome).toMatchObject({
      timedOut: true,
      requestedTimeoutMs: 300_000,
      effectiveTimeoutMs: 20,
      capped: true,
      maxWaitMs: 20,
    })
  })

  it('enforces the caller permission preset allowlist', async () => {
    const h = await setup({ agent: { allowedPermissionPresets: ['auto'] } })
    await expect(
      h.manager.submit({ task: 'wider', permissionPreset: 'danger-full-access' }),
    ).rejects.toMatchObject({ code: 'permission_denied' })

    const record = await h.manager.submit({ task: 'reviewed', permissionPreset: 'auto' })
    expect(record.permissionPreset).toBe('auto')
    expect(h.manager.stateOf(record.taskId).permissionPreset).toBe('auto')
    await h.adapter.waitForRun(record.taskId)
  })

  it('serializes tasks on the same pool key and reports blockedBy', async () => {
    const h = await setup({ agent: { maxAgents: 4, maxConcurrent: 1, defaultTimeoutMs: 10_000 } })
    const first = await h.manager.submit({ task: 'first' })
    await h.adapter.waitForRun(first.taskId)
    const second = await h.manager.submit({ task: 'second' })
    expect(second.status).toBe('queued')
    const info = h.manager.queueInfo(second.taskId)
    expect(info.blockedBy).toBe(first.taskId)
    expect(info.queuePosition).toBe(2)

    const firstRun = await h.adapter.waitForRun(first.taskId)
    firstRun.succeed('one')
    await h.manager.wait(first.taskId, { timeoutMs: 1_000 })
    const secondRun = await h.adapter.waitForRun(second.taskId)
    secondRun.succeed('two')
    expect((await h.manager.wait(second.taskId, { timeoutMs: 1_000 })).status).toBe('succeeded')
  })

  it('allows a fresh task to run in parallel with a busy pool key', async () => {
    const h = await setup({ agent: { maxAgents: 4, maxConcurrent: 2, defaultTimeoutMs: 10_000 } })
    const first = await h.manager.submit({ task: 'first' })
    await h.adapter.waitForRun(first.taskId)
    const fresh = await h.manager.submit({ task: 'fresh', sessionMode: 'fresh' })
    const freshRun = await h.adapter.waitForRun(fresh.taskId)
    expect(h.manager.get(fresh.taskId).status).toBe('running')
    freshRun.succeed('parallel')
    expect((await h.manager.wait(fresh.taskId, { timeoutMs: 1_000 })).status).toBe('succeeded')
  })

  it('cancels a queued task and a running task idempotently', async () => {
    const h = await setup({ agent: { maxAgents: 4, maxConcurrent: 1, defaultTimeoutMs: 10_000 } })
    const first = await h.manager.submit({ task: 'first' })
    await h.adapter.waitForRun(first.taskId)
    const second = await h.manager.submit({ task: 'second' })

    const canceledQueued = await h.manager.cancel(second.taskId)
    expect(canceledQueued.already).toBe(false)
    expect(canceledQueued.record.status).toBe('canceled')

    const canceledRunning = await h.manager.cancel(first.taskId)
    expect(canceledRunning.record.status).toBe('canceled')
    const run = await h.adapter.waitForRun(first.taskId)
    expect(run.cancelReason).toBe('user')
    const again = await h.manager.cancel(first.taskId)
    expect(again.already).toBe(true)
    expect(again.record.status).toBe('canceled')
  })

  it('cancels a waiting task and resolves the pending interaction', async () => {
    const h = await setup()
    const record = await h.manager.submit({ task: 'cancel waiting' })
    const run = await h.adapter.waitForRun(record.taskId)
    run.emitApproval('a_cancel')
    await h.manager.wait(record.taskId, { timeoutMs: 1_000 })
    const canceled = await h.manager.cancel(record.taskId)
    expect(canceled.record.status).toBe('canceled')
    expect(run.canceledPending).toBe(true)
    expect(h.manager.get(record.taskId).pending).toBeUndefined()
    await expect(h.manager.approve(record.taskId, 'a_cancel', 'allow-once')).rejects.toMatchObject({
      code: 'task_terminal',
    })
  })

  it('waits for approval, rejects the wrong tool, and is idempotent', async () => {
    const h = await setup()
    const record = await h.manager.submit({ task: 'needs approval' })
    const run = await h.adapter.waitForRun(record.taskId)
    run.emitApproval('a_1')
    await h.manager.wait(record.taskId, { timeoutMs: 1_000 })
    expect(h.manager.get(record.taskId).status).toBe('waiting')
    expect(h.manager.stateOf(record.taskId).pending?.kind).toBe('approval')

    await expect(h.manager.answer(record.taskId, 'a_1', [
      { questionId: 'q1', selected: ['x'] },
    ])).rejects.toMatchObject({ code: 'interaction_kind_mismatch' })
    await expect(h.manager.approve(record.taskId, 'wrong', 'allow-once')).rejects.toMatchObject({
      code: 'interaction_not_found',
    })
    expect(h.manager.get(record.taskId).pending?.requestId).toBe('a_1')

    const approved = await h.manager.approve(record.taskId, 'a_1', 'allow-once')
    expect(approved.already).toBe(false)
    expect(run.approved).toBe('allowed-once')
    expect(h.manager.get(record.taskId).status).toBe('running')
    expect(h.manager.get(record.taskId).decisions).toEqual([
      expect.objectContaining({ requestId: 'a_1', kind: 'approval', decision: 'allow-once' }),
    ])
    const duplicate = await h.manager.approve(record.taskId, 'a_1', 'allow-once')
    expect(duplicate.already).toBe(true)
    await expect(h.manager.approve(record.taskId, 'a_1', 'reject')).rejects.toMatchObject({
      code: 'interaction_expired',
    })
    run.succeed('approved')
    expect((await h.manager.wait(record.taskId, { timeoutMs: 1_000 })).status).toBe('succeeded')
    const afterFinish = await h.manager.approve(record.taskId, 'a_1', 'allow-once')
    expect(afterFinish.already).toBe(true)
  })

  it('rejects an expired decision without mutating the pending request', async () => {
    const h = await setup()
    const record = await h.manager.submit({ task: 'expired decision' })
    const run = await h.adapter.waitForRun(record.taskId)
    run.emitApproval('a_past')
    await h.manager.wait(record.taskId, { timeoutMs: 1_000 })
    const current = h.manager.get(record.taskId)
    if (current.pending === undefined) throw new Error('expected pending')
    current.pending.expiresAt = new Date(Date.now() - 1_000).toISOString()
    await expect(h.manager.approve(record.taskId, 'a_past', 'allow-once')).rejects.toMatchObject({
      code: 'interaction_expired',
    })
    expect(h.manager.get(record.taskId).status).toBe('waiting')
    expect(h.manager.get(record.taskId).pending?.requestId).toBe('a_past')
    await h.manager.cancel(record.taskId)
  })

  it('validates answers without mutating the pending question', async () => {
    const h = await setup()
    const record = await h.manager.submit({ task: 'ask me' })
    const run = await h.adapter.waitForRun(record.taskId)
    run.emitQuestion('q_1')
    await h.manager.wait(record.taskId, { timeoutMs: 1_000 })

    await expect(h.manager.answer(record.taskId, 'q_1', [])).rejects.toMatchObject({ code: 'answer_invalid' })
    await expect(
      h.manager.answer(record.taskId, 'q_1', [{ questionId: 'q1', selected: ['nope'] }]),
    ).rejects.toMatchObject({ code: 'answer_invalid' })
    expect(h.manager.get(record.taskId).pending?.requestId).toBe('q_1')

    const answered = await h.manager.answer(record.taskId, 'q_1', [{ questionId: 'q1', selected: ['safe'] }])
    expect(answered.already).toBe(false)
    expect(run.answers).toEqual([{ questionId: 'q1', selected: ['safe'] }])
    const again = await h.manager.answer(record.taskId, 'q_1', [{ questionId: 'q1', selected: ['safe'] }])
    expect(again.already).toBe(true)
    await expect(
      h.manager.answer(record.taskId, 'q_1', [{ questionId: 'q1', selected: ['fast'] }]),
    ).rejects.toMatchObject({ code: 'interaction_expired' })
  })

  it('expires a pending approval and fails the task', async () => {
    const h = await setup({
      interactions: { mode: 'remote', approvalTimeoutMs: 20, questionTimeoutMs: 20, maxWaitMs: 60_000 },
    })
    const record = await h.manager.submit({ task: 'expire' })
    const run = await h.adapter.waitForRun(record.taskId)
    run.emitApproval('a_exp')
    await h.manager.wait(record.taskId, { timeoutMs: 1_000 })
    const finished = await waitForStatus(h.manager, record.taskId, 'failed', 1_000)
    expect(finished.error?.code).toBe('approval_timeout')
    expect(run.canceledPending).toBe(true)
  })

  it('marks a timed-out running task as failed', async () => {
    const h = await setup({ agent: { maxAgents: 4, maxConcurrent: 2, defaultTimeoutMs: 20 } })
    const record = await h.manager.submit({ task: 'timeout' })
    const run = await h.adapter.waitForRun(record.taskId)
    const finished = await waitForStatus(h.manager, record.taskId, 'failed', 1_000)
    expect(finished.error?.code).toBe('timeout')
    expect(run.cancelReason).toBe('timeout')
  })

  it('lists summaries newest first and filters by status/cwd', async () => {
    const h = await setup()
    const first = await h.manager.submit({ task: 'first task' })
    const run = await h.adapter.waitForRun(first.taskId)
    run.succeed('done')
    await h.manager.wait(first.taskId, { timeoutMs: 1_000 })
    const second = await h.manager.submit({ task: 'second task' })
    const list = h.manager.list({ limit: 10 })
    expect(list.map((record) => record.taskId)).toContain(second.taskId)
    expect(list.map((record) => record.taskId)).toContain(first.taskId)
    expect(h.manager.list({ status: 'succeeded' }).map((record) => record.taskId)).toEqual([first.taskId])
    expect(h.manager.list({ cwd: process.cwd() })).toHaveLength(2)
  })

  it('rejects missing, relative, and forbidden cwd values', async () => {
    const h = await setup({ workspaceRoots: [process.cwd()] })
    await expect(h.manager.submit({ task: 'x', cwd: 'relative' })).rejects.toMatchObject({ code: 'cwd_not_found' })
    await expect(h.manager.submit({ task: 'x', cwd: '/definitely/not/here' })).rejects.toMatchObject({
      code: 'cwd_not_found',
    })
    await expect(h.manager.submit({ task: 'x', cwd: '/' })).rejects.toMatchObject({ code: 'cwd_forbidden' })
  })

  it('rejects a full queue', async () => {
    const h = await setup({
      agent: { maxAgents: 4, maxConcurrent: 1, defaultTimeoutMs: 10_000 },
      tasks: { maxQueue: 1 },
    })
    const first = await h.manager.submit({ task: 'first' })
    await h.adapter.waitForRun(first.taskId)
    await h.manager.submit({ task: 'queued' })
    await expect(h.manager.submit({ task: 'overflow' })).rejects.toMatchObject({ code: 'busy' })
  })

  it('recovers queued and running tasks from disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-task-recover-'))
    const config = resolveConfig({
      logLevel: 'error',
      tasks: { storePath: join(directory, 'tasks') },
      agent: { maxAgents: 4, maxConcurrent: 2, defaultTimeoutMs: 10_000 },
    })
    const logger = new Logger('error')
    const store = new TaskStore(config.tasks.storePath, logger)
    await store.init()
    const base = (taskId: string, status: TaskRecord['status']): TaskRecord => ({
      taskId,
      status,
      task: taskId,
      context: '',
      cwd: process.cwd(),
      sessionMode: 'reuse',
      preset: 'standard',
      createdAt: new Date().toISOString(),
    })
    await store.save({ ...base('t_running', 'running'), sessionId: 's_running', fromSeq: 100 })
    await store.save(base('t_queued', 'queued'))
    await store.save({ ...base('t_done', 'succeeded'), answer: 'persisted answer' })
    const adapter = new FakeAdapter()
    adapter.traces.set('t_running', [
      { seq: 100, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } },
      { seq: 101, type: 'tool/call', data: { name: 'bash', arguments: '{}' } },
    ])
    const manager = new TaskManager(adapter, store, config, logger)
    try {
      await manager.init()
      expect(manager.get('t_running').status).toBe('interrupted')
      expect(manager.get('t_running').pending).toBeUndefined()
      expect(manager.get('t_running').toSeq).toBe(102)
      expect(manager.get('t_done').answer).toBe('persisted answer')
      const run = await adapter.waitForRun('t_queued')
      run.succeed('recovered')
      const finished = await manager.wait('t_queued', { timeoutMs: 1_000 })
      expect(finished.status).toBe('succeeded')
      expect(finished.answer).toBe('recovered')
    } finally {
      await manager.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('reads a trace and returns trace_unavailable before start', async () => {
    const h = await setup({ agent: { maxAgents: 4, maxConcurrent: 1, defaultTimeoutMs: 10_000 } })
    const first = await h.manager.submit({ task: 'blocker' })
    await h.adapter.waitForRun(first.taskId)
    const record = await h.manager.submit({ task: 'trace me' })
    await expect(h.manager.trace(record.taskId, {})).rejects.toMatchObject({ code: 'trace_unavailable' })
    const firstRun = await h.adapter.waitForRun(first.taskId)
    firstRun.succeed('one')
    await h.manager.wait(first.taskId, { timeoutMs: 1_000 })
    const run = await h.adapter.waitForRun(record.taskId)
    h.adapter.traces.set(record.taskId, [
      { seq: 100, type: 'user/message', data: { content: [{ type: 'text', text: 'trace me' }] } },
      { seq: 101, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
    ])
    const page = await h.manager.trace(record.taskId, { limit: 10 })
    expect(page.content).toContain('[101] assistant\ndone')
    expect(page.state.nextAfterSeq).toBe(101)
    expect(page.state.hasMore).toBe(false)
    run.succeed('done')
    await h.manager.wait(record.taskId, { timeoutMs: 1_000 })
  })

  it('reports health counts without identifiers', async () => {
    const h = await setup()
    const record = await h.manager.submit({ task: 'health' })
    await h.adapter.waitForRun(record.taskId)
    expect(h.manager.health()).toEqual({
      queue: { queued: 0, running: 1, waiting: 0 },
      agents: { pooled: 0, active: 1 },
    })
    expect(JSON.stringify(h.manager.health())).not.toContain(record.taskId)
  })
})

async function waitForStatus(
  manager: TaskManager,
  taskId: string,
  status: TaskRecord['status'],
  timeoutMs: number,
): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = manager.get(taskId)
    if (record.status === status) return record
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${status}; got ${record.status}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 25))
  }
}
