import type { Context } from '@deepseek-ai/cordis'
import { DshTaskAdapter } from './agents/dsh-adapter.js'
import type { Config } from './config.js'
import { createHttpServer } from './mcp/http-server.js'
import { createRuntime } from './runtime.js'
import { TaskManager } from './tasks/manager.js'
import { TaskStore } from './tasks/store.js'

/** Cordis plugin name. */
export const name = 'dsh-task-delegation'

/** Services required before the MCP surface and agent factory are usable. */
export const inject = ['tools', 'llm', 'agents', 'agentPresets']

/** Start the MCP server and own its lifecycle through `ctx.effect`. */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const runtime = createRuntime(config)
  const store = new TaskStore(runtime.config.tasks.storePath, runtime.logger)
  const adapter = new DshTaskAdapter(
    ctx as unknown as ConstructorParameters<typeof DshTaskAdapter>[0],
    runtime.config,
    runtime.logger,
  )
  const manager = new TaskManager(adapter, store, runtime.config, runtime.logger)
  try {
    await manager.init()
  } catch (error) {
    await manager.close().catch(() => undefined)
    throw error
  }

  const handle = createHttpServer(runtime, manager)

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    handle.server.once('error', onError)
    handle.server.listen(runtime.config.http.port, runtime.config.http.host, () => {
      handle.server.off('error', onError)
      resolve()
    })
  }).catch(async (error: unknown) => {
    await handle.close()
    await manager.close()
    runtime.logger.error('MCP server failed to listen', { error })
    throw error
  })

  handle.server.on('error', (error) => runtime.logger.error('http server error', { error }))

  const address = handle.address()
  const where =
    address === null
      ? `${runtime.config.http.host}:${runtime.config.http.port}`
      : `${address.address}:${address.port}`
  runtime.logger.info(`MCP server listening on ${where}`, {
    taskStore: runtime.config.tasks.storePath,
    interactions: runtime.config.interactions.mode,
  })

  ctx.effect(
    () => async () => {
      try {
        await handle.close()
        await manager.close()
      } catch (error) {
        runtime.logger.error('shutdown failed', { error })
      }
    },
    'dsh-task-delegation',
  )
}
