import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHttpServer, type HttpServerHandle } from '../src/mcp/http-server.js'
import { createRuntime } from '../src/runtime.js'
import type { Config } from '../src/config.js'
import { createHarness, type TestHarness } from './helpers/manager.js'

let handle: HttpServerHandle | undefined
let harness: TestHarness | undefined

afterEach(async () => {
  await handle?.close()
  await harness?.close()
  handle = undefined
  harness = undefined
})

async function listen(config: Config = { http: { host: '127.0.0.1', port: 0, authToken: 'secret' } }): Promise<{ base: string; h: TestHarness }> {
  harness = await createHarness()
  const runtime = createRuntime({
    logLevel: 'error',
    ...config,
    http: { host: '127.0.0.1', port: 0, ...(config.http ?? {}) },
  })
  handle = createHttpServer(runtime, harness.manager)
  await new Promise<void>((resolve, reject) => {
    handle?.server.once('error', reject)
    handle?.server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = handle.server.address() as AddressInfo
  return { base: `http://127.0.0.1:${address.port}`, h: harness }
}

describe('http server', () => {
  it('serves healthz without auth and without identifiers', async () => {
    const { base, h } = await listen()
    const record = await h.manager.submit({ task: 'health' })
    await h.adapter.waitForRun(record.taskId)
    const response = await fetch(`${base}/healthz`)
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({
      status: 'ok',
      name: 'dsh-task-delegation',
      queue: { queued: 0, running: 1, waiting: 0 },
      agents: { pooled: 0, active: 1 },
    })
    expect(JSON.stringify(body)).not.toContain(record.taskId)
    expect(JSON.stringify(body)).not.toContain(`s_${record.taskId}`)
  })

  it('rejects MCP requests without the bearer token', async () => {
    const { base } = await listen()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('accepts an authenticated MCP initialize request', async () => {
    const { base } = await listen()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer secret',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      }),
    })
    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toContain('dsh-task-delegation')
  })

  it('denies all browser origins when the allowlist is explicitly empty', async () => {
    const { base } = await listen({
      http: { host: '127.0.0.1', port: 0, authToken: 'secret', allowedOrigins: [] },
    })
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret',
        origin: 'http://127.0.0.1',
      },
      body: '{}',
    })
    expect(response.status).toBe(403)
  })

  it('rejects a browser Origin outside the allowlist', async () => {
    const { base } = await listen()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret',
        origin: 'http://evil.example',
      },
      body: '{}',
    })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'forbidden_origin' })
  })

  it('enforces maxBodyBytes for a chunked request without Content-Length', async () => {
    const { base } = await listen({
      http: { host: '127.0.0.1', port: 0, authToken: 'secret', maxBodyBytes: 256 },
    })
    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        `${base}/mcp`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: 'Bearer secret',
          },
        },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
        },
      )
      request.on('error', reject)
      request.write('{"padding":"')
      request.write('x'.repeat(2048))
      request.end('"}')
    })
    expect(status).toBe(413)
  })

  it('rejects a request body above maxBodyBytes', async () => {
    const { base } = await listen({
      http: { host: '127.0.0.1', port: 0, authToken: 'secret', maxBodyBytes: 256 },
    })
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret',
      },
      body: JSON.stringify({ padding: 'x'.repeat(1024) }),
    })
    expect(response.status).toBe(413)
  })

  it('returns 404 for an unknown MCP session and 404/405 for unknown routes', async () => {
    const { base } = await listen()
    const unknown = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer secret',
        'mcp-session-id': 'nope',
      },
      body: '{}',
    })
    expect(unknown.status).toBe(404)
    const missing = await fetch(`${base}/nope`, { method: 'GET' })
    expect(missing.status).toBe(404)
    const wrongMethod = await fetch(`${base}/healthz`, { method: 'POST' })
    expect(wrongMethod.status).toBe(405)
  })
})
