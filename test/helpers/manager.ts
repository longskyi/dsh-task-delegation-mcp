import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, type Config, type ResolvedConfig } from '../../src/config.js'
import { Logger } from '../../src/logger.js'
import { TaskManager } from '../../src/tasks/manager.js'
import { TaskStore } from '../../src/tasks/store.js'
import { FakeAdapter } from './fake-adapter.js'

export interface TestHarness {
  adapter: FakeAdapter
  manager: TaskManager
  config: ResolvedConfig
  directory: string
  close: () => Promise<void>
}

export async function createHarness(
  config: Config = {},
  options: { manager?: boolean } = {},
): Promise<TestHarness> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-task-test-'))
  const { tasks: taskOverrides, ...rest } = config
  const resolved = resolveConfig({
    logLevel: 'error',
    http: { host: '127.0.0.1', port: 0 },
    agent: {
      maxAgents: 4,
      maxConcurrent: 2,
      defaultTimeoutMs: 10_000,
      defaultSyncWaitMs: 100,
      maxAnswerBytes: 65_536,
    },
    ...rest,
    tasks: { storePath: join(directory, 'tasks'), ...(taskOverrides ?? {}) },
  })
  const logger = new Logger('error')
  const adapter = new FakeAdapter()
  const store = new TaskStore(resolved.tasks.storePath, logger)
  const manager = new TaskManager(adapter, store, resolved, logger)
  if (options.manager !== false) await manager.init()
  return {
    adapter,
    manager,
    config: resolved,
    directory,
    close: async () => {
      await manager.close()
      await store.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
