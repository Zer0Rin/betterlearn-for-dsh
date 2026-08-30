import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  authorizeSpikeRequest,
  registerSpikeRoutes,
  type SpikeOperations,
} from '../src/spike/routes.js'
import { createAuthorizationRequest } from '../src/spike/authorization.js'
import { ProviderProbeError } from '../src/spike/provider-probe.js'

const token = 'phase1a-token-that-is-long-and-random-enough'
const servers = new Set<ReturnType<typeof createServer>>()

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  servers.clear()
  vi.restoreAllMocks()
})

function requestContract() {
  return createAuthorizationRequest({
    version: 1,
    artifactSha256: 'a'.repeat(64),
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    maxCalls: 3,
    promptSha256: 'b'.repeat(64),
    schemaSha256: 'c'.repeat(64),
    purpose: 'phase1a-public-seam-spike',
  })
}

function matchingGrant() {
  const request = requestContract()
  return {
    request,
    grant: {
      version: 1,
      requestDigest: request.requestDigest,
      authorizedProvider: request.provider,
      authorizedModel: request.model,
      authorizedMaxCalls: request.maxCalls,
      authorizedAt: '2026-08-26T04:00:00.000Z',
      authorizationSource: 'explicit-user-confirmation-in-active-codex-task',
    },
  }
}

async function listen(operations: SpikeOperations) {
  let handler: any
  const routeDisposer = vi.fn()
  const ctx = {
    webServer: {
      register(route: any) {
        expect(route.kind).toBe('prefix')
        expect(route.path).toBe('/nobei-spike/v1')
        handler = route.handler
        return routeDisposer
      },
    },
  }
  const root = new AbortController()
  const unregister = registerSpikeRoutes(ctx as never, operations, { token, rootSignal: root.signal })
  const server = createServer((req, res) => void Promise.resolve(handler(req, res)))
  servers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { port: (server.address() as AddressInfo).port, unregister, routeDisposer, root }
}

async function send(port: number, options: {
  method: string
  path: string
  headers?: Record<string, string>
  body?: string
}) {
  return await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, ...options }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    request.once('error', reject)
    request.end(options.body)
  })
}

function postHeaders(port: number): Record<string, string> {
  return {
    host: `127.0.0.1:${port}`,
    origin: `http://127.0.0.1:${port}`,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
    'x-nobei-spike-token': token,
  }
}

function operations(override: Partial<SpikeOperations> = {}): SpikeOperations {
  return {
    runSubprocess: vi.fn(async () => ({ status: 'PASS' })),
    runProvider: vi.fn(async () => [{ index: 1 }]),
    ...override,
  }
}

describe('spike route security', () => {
  test('rejects a non-loopback remote address before dispatch', () => {
    const decision = authorizeSpikeRequest({
      headers: { host: '127.0.0.1:3080', 'x-nobei-spike-token': token },
      socket: { remoteAddress: '203.0.113.9' },
    } as never, false, token)
    expect(decision).toEqual({ ok: false, status: 403, code: 'LOOPBACK_REQUIRED' })
  })

  test.each([
    ['wrong Host', (port: number) => ({ ...postHeaders(port), host: 'evil.example' }), 'UNTRUSTED_HOST'],
    ['missing Origin', (port: number) => {
      const { origin: _origin, ...headers } = postHeaders(port)
      return headers
    }, 'ORIGIN_REQUIRED'],
    ['wrong Origin', (port: number) => ({ ...postHeaders(port), origin: 'http://localhost:9999' }), 'CROSS_ORIGIN'],
    ['cross-site metadata', (port: number) => ({ ...postHeaders(port), 'sec-fetch-site': 'cross-site' }), 'CROSS_SITE'],
    ['missing token', (port: number) => {
      const { 'x-nobei-spike-token': _token, ...headers } = postHeaders(port)
      return headers
    }, 'SPIKE_TOKEN_REQUIRED'],
    ['wrong token', (port: number) => ({ ...postHeaders(port), 'x-nobei-spike-token': 'wrong' }), 'SPIKE_TOKEN_INVALID'],
  ])('rejects %s', async (_name, headers, code) => {
    const ops = operations()
    const { port } = await listen(ops)
    const response = await send(port, {
      method: 'POST', path: '/nobei-spike/v1/subprocess', headers: headers(port), body: '{}',
    })
    expect(response.status).toBe(403)
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: { code } })
    expect(ops.runSubprocess).not.toHaveBeenCalled()
  })

  test.each([
    ['wrong method', { method: 'GET', contentType: 'application/json', body: '{}' }, 405, 'METHOD_NOT_ALLOWED'],
    ['wrong media type', { method: 'POST', contentType: 'text/plain', body: '{}' }, 415, 'JSON_REQUIRED'],
    ['oversized body', { method: 'POST', contentType: 'application/json', body: JSON.stringify('x'.repeat(65_535)) }, 413, 'BODY_TOO_LARGE'],
  ])('rejects %s with a closed error', async (_name, input, status, code) => {
    const ops = operations()
    const { port } = await listen(ops)
    const response = await send(port, {
      method: input.method,
      path: '/nobei-spike/v1/subprocess',
      headers: { ...postHeaders(port), 'content-type': input.contentType },
      body: input.body,
    })
    expect(response.status).toBe(status)
    expect(JSON.parse(response.body)).toEqual({ ok: false, error: { code } })
    expect(response.body).not.toContain('stack')
  })

  test('rejects unknown body fields and a mismatched grant', async () => {
    const ops = operations()
    const { port } = await listen(ops)
    const unknown = await send(port, {
      method: 'POST', path: '/nobei-spike/v1/subprocess', headers: postHeaders(port), body: '{"path":"/tmp"}',
    })
    expect(JSON.parse(unknown.body)).toEqual({ ok: false, error: { code: 'REQUEST_BODY_INVALID' } })

    const { request, grant } = matchingGrant()
    const mismatched = await send(port, {
      method: 'POST',
      path: '/nobei-spike/v1/provider',
      headers: postHeaders(port),
      body: JSON.stringify({ authorizationRequest: request, authorizationGrant: { ...grant, authorizedModel: 'wrong' } }),
    })
    expect(JSON.parse(mismatched.body)).toEqual({ ok: false, error: { code: 'AUTHORIZATION_INVALID' } })
    expect(ops.runProvider).not.toHaveBeenCalled()
  })

  test('makes the provider route single-use across concurrent and repeated requests', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const ops = operations({ runProvider: vi.fn(async () => { await pending; return [] }) })
    const { port } = await listen(ops)
    const { request, grant } = matchingGrant()
    const input = {
      method: 'POST', path: '/nobei-spike/v1/provider', headers: postHeaders(port),
      body: JSON.stringify({ authorizationRequest: request, authorizationGrant: grant }),
    }
    const first = send(port, input)
    await vi.waitFor(() => expect(ops.runProvider).toHaveBeenCalledTimes(1))
    const concurrent = await send(port, input)
    expect(concurrent.status).toBe(409)
    expect(JSON.parse(concurrent.body)).toEqual({ ok: false, error: { code: 'PROVIDER_PROBE_ALREADY_USED' } })
    finish()
    expect((await first).status).toBe(200)
    const repeated = await send(port, input)
    expect(repeated.status).toBe(409)
    expect(ops.runProvider).toHaveBeenCalledTimes(1)
  })

  test('returns only a sanitized provider failure code and exact attempted-call count', async () => {
    const ops = operations({
      runProvider: vi.fn(async () => {
        throw new ProviderProbeError(0, 'WORKFLOW_RUNTIME', new Error('sensitive upstream detail'))
      }),
    })
    const { port } = await listen(ops)
    const { request, grant } = matchingGrant()
    const response = await send(port, {
      method: 'POST',
      path: '/nobei-spike/v1/provider',
      headers: postHeaders(port),
      body: JSON.stringify({ authorizationRequest: request, authorizationGrant: grant }),
    })
    expect(response.status).toBe(500)
    expect(JSON.parse(response.body)).toEqual({
      ok: false,
      error: { code: 'PROBE_FAILED', actualCalls: 0, failureStage: 'WORKFLOW_RUNTIME' },
    })
    expect(response.body).not.toContain('sensitive')
  })

  test('serves token-protected health and returns the exact route disposer', async () => {
    const ops = operations()
    const { port, unregister, routeDisposer } = await listen(ops)
    const response = await send(port, {
      method: 'GET', path: '/nobei-spike/v1/health',
      headers: { host: `127.0.0.1:${port}`, 'x-nobei-spike-token': token },
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true, service: 'nobei-phase1a-spike' })
    unregister()
    expect(routeDisposer).toHaveBeenCalledTimes(1)
  })
})
