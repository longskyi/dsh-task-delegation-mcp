import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DshTaskAdapter } from '../src/agents/dsh-adapter.js'
import { resolveConfig, type Config } from '../src/config.js'
import { Logger } from '../src/logger.js'
import { TaskManager } from '../src/tasks/manager.js'
import { TaskStore } from '../src/tasks/store.js'
import type { TaskRecord } from '../src/types.js'
import { FakeDshContext } from './helpers/fake-dsh.js'

interface Harness {
  ctx: FakeDshContext
  manager: TaskManager
  adapter: DshTaskAdapter
  directory: string
  close: () => Promise<void>
}

let harness: Harness | undefined

afterEach(async () => {
  await harness?.close()
  harness = undefined
})

async function setup(config: Config = {}, prepare?: (ctx: FakeDshContext) => void): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-real-adapter-'))
  const resolved = resolveConfig({
    logLevel: 'error',
    tasks: { storePath: join(directory, 'tasks') },
    agent: {
      maxAgents: 4,
      maxConcurrent: 2,
      defaultTimeoutMs: 10_000,
      defaultSyncWaitMs: 100,
      preset: 'standard',
    },
    ...config,
  })
  const logger = new Logger('error')
  const ctx = new FakeDshContext()
  prepare?.(ctx)
  const adapter = new DshTaskAdapter(
    ctx as unknown as ConstructorParameters<typeof DshTaskAdapter>[0],
    resolved,
    logger,
  )
  const store = new TaskStore(resolved.tasks.storePath, logger)
  const manager = new TaskManager(adapter, store, resolved, logger)
  await manager.init()
  const h: Harness = {
    ctx,
    manager,
    adapter,
    directory,
    close: async () => {
      await manager.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
  harness = h
  return h
}

async function waitForStatus(manager: TaskManager, taskId: string, status: TaskRecord['status']): Promise<TaskRecord> {
  const deadline = Date.now() + 2_000
  for (;;) {
    const record = manager.get(taskId)
    if (record.status === status) return record
    if (Date.now() > deadline) throw new Error(`wanted ${status}, got ${record.status}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 10))
  }
}

describe('DSH adapter', () => {
  it('creates a session, mounts the preset, and extracts the final answer', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = (agent) => {
        agent.complete('# Report\n\nAll good.')
      }
    })
    const record = await h.manager.submit({ task: 'do the thing', context: 'background' })
    const finished = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(finished.status).toBe('succeeded')
    expect(finished.answer).toBe('# Report\n\nAll good.')
    expect(h.ctx.mounts).toEqual(['standard'])
    expect(h.ctx.created).toHaveLength(1)
    const created = h.ctx.created[0] as {
      meta: { cwd: string; agentPreset: string }
      agentOptions: { provider: string; model: string }
    }
    expect(created.meta.cwd).toBe(process.cwd())
    expect(created.meta.agentPreset).toBe('standard')
    expect(created.agentOptions).toEqual({ provider: 'deepseek-official', model: 'deepseek-chat' })
    const agent = h.ctx.agentsById.get(finished.sessionId as string)
    expect(agent?.messages[0]?.source.kind).toBe('plugin:dsh-task-delegation')
    expect(agent?.messages[0]?.content[0]?.text).toContain('Task:\ndo the thing')
    expect(agent?.messages[0]?.content[0]?.text).toContain('Context:\nbackground')
    expect(agent?.messages[0]?.content[0]?.text).not.toContain('one line JSON')
  })

  it('preserves a final answer verbatim, including surrounding whitespace', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = (agent) => {
        agent.complete('  # Title\n\n- item\n\n')
      }
    })
    const record = await h.manager.submit({ task: 'verbatim' })
    const finished = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(finished.answer).toBe('  # Title\n\n- item\n\n')
  })

  it('truncates an oversized answer with an explicit marker', async () => {
    const h = await setup({ agent: { maxAnswerBytes: 24 } }, (ctx) => {
      ctx.onFollowup = (agent) => agent.complete('x'.repeat(200))
    })
    const record = await h.manager.submit({ task: 'long answer' })
    const finished = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(finished.answer).toContain('[truncated]')
    expect(Buffer.byteLength(finished.answer ?? '')).toBeLessThanOrEqual(24)
  })

  it('uses the last assistant message as the answer', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = (agent) => {
        agent.session.append('assistant/message', {
          turn: 1,
          step: 1,
          message: { content: [{ type: 'text', text: 'first' }] },
          stream: [],
        })
        agent.complete('second')
      }
    })
    const record = await h.manager.submit({ task: 'last' })
    const finished = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(finished.answer).toBe('second')
  })

  it('maps a turn error to a failed task', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = (agent) => agent.fail('boom')
    })
    const record = await h.manager.submit({ task: 'fail' })
    const finished = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(finished.status).toBe('failed')
    expect(finished.error).toEqual({ code: 'agent_failed', message: 'boom' })
  })

  it('routes an approval through the manager and resumes the turn', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = async (agent) => {
        const outcome = await agent.requestApproval('bash', 'rm -rf build')
        agent.complete(`approval ${outcome}`)
      }
    })
    const record = await h.manager.submit({ task: 'approve' })
    const waiting = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(waiting.status).toBe('waiting')
    expect(waiting.pending).toMatchObject({ kind: 'approval', toolName: 'bash', reason: 'rm -rf build' })
    const requestId = waiting.pending?.requestId as string
    await h.manager.approve(record.taskId, requestId, 'allow-once')
    const finished = await waitForStatus(h.manager, record.taskId, 'succeeded')
    expect(finished.answer).toBe('approval allowed-once')
    const agent = h.ctx.agentsById.get(finished.sessionId as string)
    expect(agent?.approvals).toEqual(['allowed-once'])
  })

  it('fails closed when interaction mode is deny', async () => {
    const h = await setup(
      { interactions: { mode: 'deny', approvalTimeoutMs: 5_000, questionTimeoutMs: 5_000, maxWaitMs: 60_000 } },
      (ctx) => {
        ctx.onFollowup = async (agent) => {
          const outcome = await agent.requestApproval('bash', 'needs approval')
          agent.complete(`approval ${outcome}`)
        }
      },
    )
    const record = await h.manager.submit({ task: 'denied' })
    const finished = await waitForStatus(h.manager, record.taskId, 'failed')
    expect(finished.error?.code).toBe('approval_required')
  })

  it('routes a user question and resumes the turn', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = async (agent) => {
        const answer = await agent.requestQuestion()
        agent.complete(JSON.stringify(answer))
      }
    })
    const record = await h.manager.submit({ task: 'question' })
    const waiting = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(waiting.status).toBe('waiting')
    expect(waiting.pending).toMatchObject({ kind: 'question', questions: [{ id: 'q1' }] })
    const requestId = waiting.pending?.requestId as string
    await h.manager.answer(record.taskId, requestId, [{ questionId: 'q1', selected: ['safe'] }])
    const finished = await waitForStatus(h.manager, record.taskId, 'succeeded')
    expect(finished.answer).toBe('{"answers":[{"id":"q1","selected":["safe"]}]}')
  })

  it('reuses a pooled session and creates a new one for fresh mode', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = (agent) => agent.complete('ok')
    })
    const first = await h.manager.submit({ task: 'first' })
    const firstDone = await h.manager.wait(first.taskId, { timeoutMs: 2_000 })
    const second = await h.manager.submit({ task: 'second' })
    const secondDone = await h.manager.wait(second.taskId, { timeoutMs: 2_000 })
    expect(secondDone.sessionId).toBe(firstDone.sessionId)
    expect(h.ctx.created).toHaveLength(1)

    const fresh = await h.manager.submit({ task: 'fresh', sessionMode: 'fresh' })
    const freshDone = await h.manager.wait(fresh.taskId, { timeoutMs: 2_000 })
    expect(freshDone.sessionId).not.toBe(firstDone.sessionId)
    expect(h.ctx.created).toHaveLength(2)
  })

  it('resumes an explicit session and rejects a cwd mismatch', async () => {
    const h = await setup({}, (ctx) => {
      ctx.persistence.sessions.set('s_existing', {
        header: { cwd: process.cwd() },
        events: [{ seq: 0, type: 'user/message', data: { content: [{ type: 'text', text: 'old' }] } }],
      })
      ctx.onFollowup = (agent) => agent.complete('resumed')
    })
    const record = await h.manager.submit({ task: 'resume', sessionId: 's_existing' })
    const finished = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(finished.status).toBe('succeeded')
    expect(finished.answer).toBe('resumed')
    expect(h.ctx.resumed).toHaveLength(1)

    await h.close()
    harness = undefined

    const second = await setup({}, (ctx) => {
      ctx.persistence.sessions.set('s_other', { header: { cwd: '/somewhere/else' }, events: [] })
    })
    const mismatch = await second.manager.submit({ task: 'mismatch', sessionId: 's_other' })
    const failed = await second.manager.wait(mismatch.taskId, { timeoutMs: 2_000 })
    expect(failed.status).toBe('failed')
    expect(failed.error?.code).toBe('cwd_mismatch')
  })

  it('cancels a running agent', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = () => new Promise(() => undefined)
    })
    const record = await h.manager.submit({ task: 'hang' })
    await waitForStatus(h.manager, record.taskId, 'running')
    let sessionId = h.manager.get(record.taskId).sessionId
    while (sessionId === undefined) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 5))
      sessionId = h.manager.get(record.taskId).sessionId
    }
    const agent = h.ctx.agentsById.get(sessionId)
    const canceled = await h.manager.cancel(record.taskId)
    expect(canceled.record.status).toBe('canceled')
    expect(agent?.cancelCause).toBe('user')
  })

  it('reads a persisted trace after a fresh session is disposed', async () => {
    const h = await setup({}, (ctx) => {
      ctx.onFollowup = (agent) => agent.complete('done')
    })
    const record = await h.manager.submit({ task: 'trace', sessionMode: 'fresh' })
    const finished = await h.manager.wait(record.taskId, { timeoutMs: 2_000 })
    expect(finished.status).toBe('succeeded')
    const page = await h.manager.trace(record.taskId, { limit: 50 })
    expect(page.content).toContain('assistant\ndone')
    expect(page.state.taskId).toBe(record.taskId)
  })

  it('disposes a session that was created while shutting down', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await setup({}, (ctx) => {
      ctx.createGate = gate
      ctx.onFollowup = () => {
        throw new Error('followup must not run during shutdown')
      }
    })
    await h.manager.submit({ task: 'shutdown race' })
    await new Promise((resolveWait) => setTimeout(resolveWait, 20))
    await h.manager.close()
    harness = undefined
    release()
    const deadline = Date.now() + 1_000
    while (h.ctx.agentsById.size > 0 && Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10))
    }
    expect(h.ctx.agentsById.size).toBe(0)
    await rm(h.directory, { recursive: true, force: true })
  })

  it('maps missing model and missing preset to agent_unavailable', async () => {
    const noModel = await setup({}, (ctx) => {
      ctx.modelSelection = undefined
    })
    const first = await noModel.manager.submit({ task: 'no model' })
    const failed = await noModel.manager.wait(first.taskId, { timeoutMs: 2_000 })
    expect(failed.error?.code).toBe('agent_unavailable')
    await noModel.close()
    harness = undefined

    const noPreset = await setup({ agent: { preset: 'missing' } })
    const second = await noPreset.manager.submit({ task: 'no preset' })
    const failedPreset = await noPreset.manager.wait(second.taskId, { timeoutMs: 2_000 })
    expect(failedPreset.error?.code).toBe('agent_unavailable')
    expect(failedPreset.error?.message).toContain('missing')
  })
})
