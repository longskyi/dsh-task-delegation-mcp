import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Logger } from '../src/logger.js'
import { TaskStore } from '../src/tasks/store.js'
import type { TaskRecord } from '../src/types.js'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function store(): Promise<{ store: TaskStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-task-store-'))
  directories.push(directory)
  const instance = new TaskStore(directory, new Logger('error'))
  await instance.init()
  return { store: instance, directory }
}

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: 't_abc123',
    status: 'succeeded',
    task: 'do it',
    context: '',
    cwd: '/tmp',
    sessionMode: 'reuse',
    preset: 'standard',
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('TaskStore', () => {
  it('round-trips records without leaving temporary files', async () => {
    const { store: instance, directory } = await store()
    await instance.save(record({ taskId: 't_one', answer: 'hello' }))
    const loaded = await instance.loadAll()
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.answer).toBe('hello')
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('serializes concurrent writes for the same task', async () => {
    const { store: instance } = await store()
    await Promise.all([
      instance.save(record({ taskId: 't_same', answer: 'first' })),
      instance.save(record({ taskId: 't_same', answer: 'second' })),
    ])
    const loaded = await instance.loadAll()
    expect(loaded[0]?.answer).toBe('second')
  })

  it('quarantines an unreadable file instead of failing startup', async () => {
    const { store: instance, directory } = await store()
    await writeFile(join(directory, 't_bad.json'), '{not json', 'utf8')
    const loaded = await instance.loadAll()
    expect(loaded).toEqual([])
    expect((await readdir(directory)).some((name) => name.startsWith('t_bad.json.corrupt-'))).toBe(true)
  })

  it('prunes expired and excess terminal records but keeps queued ones', async () => {
    const { store: instance } = await store()
    const now = Date.now()
    const old = new Date(now - 10_000).toISOString()
    await instance.save(record({ taskId: 't_old', createdAt: old, finishedAt: old }))
    await instance.save(record({ taskId: 't_new', createdAt: new Date(now).toISOString() }))
    await instance.save(record({ taskId: 't_queued', status: 'queued', createdAt: new Date(now).toISOString() }))
    const records = await instance.loadAll()
    const removed = await instance.prune(records, 5_000, 1, now)
    expect(removed).toContain('t_old')
    expect(removed).not.toContain('t_new')
    expect(removed).not.toContain('t_queued')
    expect((await instance.loadAll()).map((item) => item.taskId).sort()).toEqual(['t_new', 't_queued'])
  })

  it('rejects an unsafe task id', async () => {
    const { store: instance } = await store()
    await expect(instance.save(record({ taskId: '../escape' }))).rejects.toThrow(/invalid task id/)
  })
})
