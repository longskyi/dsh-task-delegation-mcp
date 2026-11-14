import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../src/mcp/server.js'
import { createRuntime } from '../src/runtime.js'
import { createHarness, type TestHarness } from './helpers/manager.js'

let harness: TestHarness | undefined
let client: Client | undefined
let server: McpServer | undefined

afterEach(async () => {
  await client?.close()
  await server?.close()
  await harness?.close()
  client = undefined
  server = undefined
  harness = undefined
})

async function setup(config = {}): Promise<{ h: TestHarness; client: Client }> {
  harness = await createHarness(config)
  const runtime = createRuntime({ logLevel: 'error', http: { port: 0 } })
  server = createMcpServer(runtime, harness.manager)
  client = new Client({ name: 'test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { h: harness, client }
}

function structured<T>(result: unknown): T {
  return (result as { structuredContent?: T }).structuredContent as T
}

function text(result: unknown): string {
  return (result as { content: { type: string; text: string }[] }).content[0]?.text ?? ''
}

describe('MCP tools', () => {
  it('lists exactly the nine core tools', async () => {
    const { client } = await setup()
    const tools = await client.listTools()
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'dsh_agent_run',
      'dsh_task_answer',
      'dsh_task_approve',
      'dsh_task_cancel',
      'dsh_task_get',
      'dsh_task_list',
      'dsh_task_submit',
      'dsh_task_trace',
      'dsh_task_wait',
    ])
  })

  it('returns the final answer verbatim and keeps it out of structuredContent', async () => {
    const { h, client } = await setup()
    const submitted = await client.callTool({ name: 'dsh_task_submit', arguments: { task: 'write a report' } })
    const taskId = structured<{ taskId: string }>(submitted).taskId
    expect(text(submitted)).toContain('is queued')
    expect(text(submitted)).not.toContain('still running')
    const run = await h.adapter.waitForRun(taskId)
    const answer = '# Report\n\n- one\n- two'
    run.succeed(answer)
    const waited = await client.callTool({ name: 'dsh_task_wait', arguments: { taskId, timeoutMs: 1_000 } })
    expect(text(waited)).toBe(answer)
    expect(structured(waited)).toEqual({ taskId, status: 'succeeded', sessionId: `s_${taskId}` })
    const got = await client.callTool({ name: 'dsh_task_get', arguments: { taskId } })
    expect(text(got)).toBe(answer)
  })

  it('reports a wait timeout and any cap in content', async () => {
    const { h, client } = await setup({
      agent: { defaultSyncWaitMs: 10 },
      interactions: { maxWaitMs: 20 },
    })
    const submitted = await client.callTool({ name: 'dsh_task_submit', arguments: { task: 'slow' } })
    const taskId = structured<{ taskId: string }>(submitted).taskId
    await h.adapter.waitForRun(taskId)
    const waited = await client.callTool({
      name: 'dsh_task_wait',
      arguments: { taskId, timeoutMs: 300_000 },
    })
    expect((waited as { isError?: boolean }).isError).not.toBe(true)
    expect(text(waited)).toContain('Wait timed out after 20 ms')
    expect(text(waited)).toContain('requested 300000 ms')
    expect(text(waited)).toContain('interactions.maxWaitMs=20')
    expect(structured(waited)).toMatchObject({ taskId, status: 'running' })
  })

  it('does not cancel a task when the MCP request is aborted', async () => {
    const { h, client } = await setup()
    const submitted = await client.callTool({ name: 'dsh_task_submit', arguments: { task: 'keep running' } })
    const taskId = structured<{ taskId: string }>(submitted).taskId
    const run = await h.adapter.waitForRun(taskId)
    const controller = new AbortController()
    const waiting = client.callTool(
      { name: 'dsh_task_wait', arguments: { taskId, timeoutMs: 10_000 } },
      undefined,
      { signal: controller.signal },
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    controller.abort()
    await expect(waiting).rejects.toThrow()
    expect(h.manager.get(taskId).status).toBe('running')
    expect(run.cancelReason).toBeUndefined()
    run.succeed('finished later')
    await h.manager.wait(taskId, { timeoutMs: 1_000 })
  })

  it('accepts an allowed permission preset and rejects others', async () => {
    const { client } = await setup({ agent: { allowedPermissionPresets: ['auto'] } })
    const accepted = await client.callTool({
      name: 'dsh_task_submit',
      arguments: { task: 'auto', permissionPreset: 'auto' },
    })
    expect(structured(accepted)).toMatchObject({ status: 'queued', permissionPreset: 'auto' })

    const rejected = await client.callTool({
      name: 'dsh_task_submit',
      arguments: { task: 'wide', permissionPreset: 'danger-full-access' },
    })
    expect((rejected as { isError?: boolean }).isError).toBe(true)
    expect(text(rejected)).toContain('agent.allowedPermissionPresets')
    expect(structured<{ error: { code: string } }>(rejected).error.code).toBe('permission_denied')
  })

  it('runs a one-shot task and always exposes the taskId', async () => {
    const { h, client } = await setup()
    h.adapter.autoAnswer = 'Linux'
    const result = await client.callTool({
      name: 'dsh_agent_run',
      arguments: { task: 'uname -s', timeoutMs: 1_000 },
    })
    expect(text(result)).toBe('Linux')
    const state = structured<{ taskId: string; status: string }>(result)
    expect(state.taskId).toMatch(/^t_/)
    expect(state.status).toBe('succeeded')
  })

  it('reports a waiting approval with the exact next tool', async () => {
    const { h, client } = await setup()
    const submitted = await client.callTool({ name: 'dsh_task_submit', arguments: { task: 'approve me' } })
    const taskId = structured<{ taskId: string }>(submitted).taskId
    const run = await h.adapter.waitForRun(taskId)
    run.emitApproval('a_42', 'bash', 'needs network')
    const got = await client.callTool({ name: 'dsh_task_get', arguments: { taskId } })
    expect(text(got)).toContain('requestId a_42')
    expect(text(got)).toContain('dsh_task_approve')
    expect(structured(got)).toMatchObject({
      taskId,
      status: 'waiting',
      pending: { kind: 'approval', requestId: 'a_42', toolName: 'bash' },
    })

    const wrong = await client.callTool({
      name: 'dsh_task_answer',
      arguments: { taskId, requestId: 'a_42', answers: [{ questionId: 'q1', selected: ['x'] }] },
    })
    expect((wrong as { isError?: boolean }).isError).toBe(true)
    expect(text(wrong)).toContain('waiting for approval')
    expect(structured<{ error: { code: string }; state: { pending?: unknown } }>(wrong).error.code).toBe(
      'interaction_kind_mismatch',
    )
    expect(h.manager.get(taskId).pending?.requestId).toBe('a_42')

    const approved = await client.callTool({
      name: 'dsh_task_approve',
      arguments: { taskId, requestId: 'a_42', decision: 'allow-once' },
    })
    expect((approved as { isError?: boolean }).isError).not.toBe(true)
    expect(run.approved).toBe('allowed-once')
    run.succeed('approved and done')
    const waited = await client.callTool({ name: 'dsh_task_wait', arguments: { taskId, timeoutMs: 1_000 } })
    expect(text(waited)).toBe('approved and done')
  })

  it('returns actionable errors for unknown tasks and invalid decisions', async () => {
    const { client } = await setup()
    const missing = await client.callTool({ name: 'dsh_task_get', arguments: { taskId: 't_missing' } })
    expect((missing as { isError?: boolean }).isError).toBe(true)
    expect(text(missing)).toContain('dsh_task_list')
    expect(structured<{ error: { code: string } }>(missing).error.code).toBe('task_not_found')
  })

  it('answers a question and reports invalid answers without mutating it', async () => {
    const { h, client } = await setup()
    const submitted = await client.callTool({ name: 'dsh_task_submit', arguments: { task: 'ask' } })
    const taskId = structured<{ taskId: string }>(submitted).taskId
    const run = await h.adapter.waitForRun(taskId)
    run.emitQuestion('q_7')
    const waiting = await client.callTool({ name: 'dsh_task_wait', arguments: { taskId, timeoutMs: 1_000 } })
    expect(text(waiting)).toContain('dsh_task_answer')
    expect(structured(waiting)).toMatchObject({ status: 'waiting', pending: { kind: 'question' } })

    const invalid = await client.callTool({
      name: 'dsh_task_answer',
      arguments: { taskId, requestId: 'q_7', answers: [{ questionId: 'q1', selected: ['unknown'] }] },
    })
    expect((invalid as { isError?: boolean }).isError).toBe(true)
    expect(structured<{ error: { code: string } }>(invalid).error.code).toBe('answer_invalid')
    expect(h.manager.get(taskId).pending?.requestId).toBe('q_7')

    const answered = await client.callTool({
      name: 'dsh_task_answer',
      arguments: { taskId, requestId: 'q_7', answers: [{ questionId: 'q1', selected: ['safe'] }] },
    })
    expect((answered as { isError?: boolean }).isError).not.toBe(true)
    expect(run.answers).toEqual([{ questionId: 'q1', selected: ['safe'] }])
    run.succeed('answered')
    expect(text(await client.callTool({ name: 'dsh_task_wait', arguments: { taskId, timeoutMs: 1_000 } }))).toBe('answered')
  })

  it('cancels and lists tasks without duplicating summaries', async () => {
    const { h, client } = await setup()
    const submitted = await client.callTool({ name: 'dsh_task_submit', arguments: { task: 'long task' } })
    const taskId = structured<{ taskId: string }>(submitted).taskId
    await h.adapter.waitForRun(taskId)
    const canceled = await client.callTool({ name: 'dsh_task_cancel', arguments: { taskId } })
    expect(text(canceled)).toBe(`Task ${taskId} canceled.`)
    const again = await client.callTool({ name: 'dsh_task_cancel', arguments: { taskId } })
    expect(text(again)).toContain('nothing to cancel')

    const list = await client.callTool({ name: 'dsh_task_list', arguments: {} })
    expect(text(list)).toContain(taskId)
    expect(structured<{ taskIds: string[] }>(list).taskIds).toEqual([taskId])
  })

  it('returns a readable trace and paginates', async () => {
    const { h, client } = await setup()
    const submitted = await client.callTool({ name: 'dsh_task_submit', arguments: { task: 'trace' } })
    const taskId = structured<{ taskId: string }>(submitted).taskId
    const run = await h.adapter.waitForRun(taskId)
    h.adapter.traces.set(taskId, [
      { seq: 100, type: 'user/message', data: { content: [{ type: 'text', text: 'trace' }] } },
      { seq: 101, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } },
    ])
    const first = await client.callTool({ name: 'dsh_task_trace', arguments: { taskId, limit: 1 } })
    expect(text(first)).toContain('[100] user')
    expect(structured(first)).toMatchObject({ taskId, nextAfterSeq: 100, hasMore: true })
    const second = await client.callTool({
      name: 'dsh_task_trace',
      arguments: { taskId, afterSeq: 100, limit: 1 },
    })
    expect(text(second)).toContain('[101] assistant')
    run.succeed('done')
  })
})
