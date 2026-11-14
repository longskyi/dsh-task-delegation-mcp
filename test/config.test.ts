import { describe, expect, it } from 'vitest'
import { isLoopbackHost, resolveConfig } from '../src/config.js'

describe('resolveConfig', () => {
  it('applies the documented defaults', () => {
    const config = resolveConfig()
    expect(config.http.host).toBe('127.0.0.1')
    expect(config.http.port).toBe(8957)
    expect(config.http.authToken).toBe('')
    expect(config.http.maxBodyBytes).toBe(1024 * 1024)
    expect(config.agent.preset).toBe('standard')
    expect(config.agent.permissionPreset).toBe('')
    expect(config.agent.allowedPermissionPresets).toEqual([])
    expect(config.agent.maxAgents).toBe(8)
    expect(config.agent.maxConcurrent).toBe(4)
    expect(config.agent.defaultTimeoutMs).toBe(1_800_000)
    expect(config.agent.defaultSyncWaitMs).toBe(30_000)
    expect(config.agent.idleTtlMs).toBe(1_800_000)
    expect(config.agent.maxAnswerBytes).toBe(65_536)
    expect(config.tasks.ttlMs).toBe(604_800_000)
    expect(config.tasks.maxRetained).toBe(1_000)
    expect(config.tasks.maxQueue).toBe(100)
    expect(config.interactions.mode).toBe('remote')
    expect(config.interactions.approvalTimeoutMs).toBe(300_000)
    expect(config.interactions.questionTimeoutMs).toBe(300_000)
    expect(config.interactions.maxWaitMs).toBe(1_800_000)
    expect(config.workspaceRoots).toEqual([])
    expect(config.logLevel).toBe('info')
  })

  it('defaults non-loopback approval mode to deny and denies browser origins', () => {
    const config = resolveConfig({ http: { host: '0.0.0.0', authToken: 'secret' } })
    expect(config.interactions.mode).toBe('deny')
    expect(config.http.allowedOrigins).toEqual([])
  })

  it('allows remote approval on a non-loopback bind only when explicit', () => {
    const config = resolveConfig({
      http: { host: '0.0.0.0', authToken: 'secret' },
      interactions: { mode: 'remote' },
    })
    expect(config.interactions.mode).toBe('remote')
  })

  it('refuses a non-loopback bind without a token', () => {
    expect(() => resolveConfig({ http: { host: '0.0.0.0' } })).toThrow(/authToken/)
  })

  it('accepts a non-loopback bind with a token', () => {
    const config = resolveConfig({ http: { host: '0.0.0.0', authToken: 'secret' } })
    expect(config.http.host).toBe('0.0.0.0')
    expect(config.http.authToken).toBe('secret')
  })

  it('rejects an invalid port', () => {
    expect(() => resolveConfig({ http: { port: 70000 } })).toThrow(/port/)
  })

  it('rejects an invalid body limit', () => {
    expect(() => resolveConfig({ http: { maxBodyBytes: 0 } })).toThrow(/maxBodyBytes/)
  })

  it('rejects a non-positive concurrency and accepts a disabled task timeout', () => {
    expect(() => resolveConfig({ agent: { maxConcurrent: 0 } })).toThrow(/maxConcurrent/)
    expect(resolveConfig({ agent: { defaultTimeoutMs: 0 } }).agent.defaultTimeoutMs).toBe(0)
    expect(() => resolveConfig({ agent: { defaultTimeoutMs: -1 } })).toThrow(/defaultTimeoutMs/)
    expect(() => resolveConfig({ tasks: { maxQueue: 0 } })).toThrow(/maxQueue/)
  })

  it('normalizes caller permission preset allowlists', () => {
    const config = resolveConfig({
      agent: { allowedPermissionPresets: [' auto ', 'auto', 'workspace-write'] },
    })
    expect(config.agent.allowedPermissionPresets).toEqual(['auto', 'workspace-write'])
    expect(() =>
      resolveConfig({ agent: { allowedPermissionPresets: [''] } }),
    ).toThrow(/allowedPermissionPresets/)
  })

  it('rejects maxConcurrent greater than maxAgents', () => {
    expect(() => resolveConfig({ agent: { maxAgents: 2, maxConcurrent: 3 } })).toThrow(/maxConcurrent/)
  })

  it('requires absolute workspace roots', () => {
    expect(() => resolveConfig({ workspaceRoots: ['relative/path'] })).toThrow(/absolute/)
  })

  it('requires an absolute task store path', () => {
    expect(() => resolveConfig({ tasks: { storePath: 'relative' } })).toThrow(/absolute/)
  })

  it('normalizes a bracketed IPv6 loopback host', () => {
    expect(resolveConfig({ http: { host: '[::1]' } }).http.host).toBe('::1')
  })

  it('validates and preserves an explicit origin allowlist', () => {
    expect(resolveConfig({ http: { allowedOrigins: [] } }).http.allowedOrigins).toEqual([])
    expect(resolveConfig({ http: { allowedOrigins: ['http://localhost:9000'] } }).http.allowedOrigins).toEqual([
      'http://localhost:9000',
    ])
    expect(() => resolveConfig({ http: { allowedOrigins: ['http://localhost:9000/path'] } })).toThrow(/origin/i)
    expect(() => resolveConfig({ http: { allowedOrigins: ['not a url'] } })).toThrow(/origin/i)
  })

  it('recognizes loopback hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
  })
})
