import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isIP } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  verifyAuthorizationRequest,
  verifyGrant,
} from './authorization.js'
import { ProviderProbeError } from './provider-probe.js'

const BODY_LIMIT = 64 * 1024

export interface SpikeOperations {
  runSubprocess(signal: AbortSignal): Promise<unknown>
  runProvider(signal: AbortSignal): Promise<unknown>
}

interface RouteOptions {
  token: string
  rootSignal: AbortSignal
}

type Decision =
  | { ok: true }
  | { ok: false; status: 403; code: string }

interface Authority {
  hostname: string
  port: number
}

class BodyError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string) {
    super(code)
  }
}

function loopbackHostname(raw: string): string | undefined {
  const hostname = raw.toLowerCase()
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return hostname
  const ipv4 = /^(127)\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (ipv4 && ipv4.slice(2).every((part) => Number(part) <= 255)) return hostname
  const mapped = /^(?:\[)?::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\])?$/.exec(hostname)
  if (mapped && loopbackHostname(mapped[1])) return hostname
  return undefined
}

function authority(raw: string | undefined): Authority | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(`http://${raw}`)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    const hostname = loopbackHostname(url.hostname)
    if (!hostname) return undefined
    const port = url.port ? Number(url.port) : 80
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
    return { hostname, port }
  } catch {
    return undefined
  }
}

function originAuthority(raw: string | undefined): Authority | undefined {
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      return undefined
    }
    return authority(url.host)
  } catch {
    return undefined
  }
}

function sameAuthority(left: Authority, right: Authority): boolean {
  return left.hostname === right.hostname && left.port === right.port
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
}

export function authorizeSpikeRequest(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  mutation: boolean,
  expectedToken: string,
): Decision {
  if (!loopbackHostname(req.socket.remoteAddress ?? '')) {
    return { ok: false, status: 403, code: 'LOOPBACK_REQUIRED' }
  }
  const host = singleHeader(req as IncomingMessage, 'host')
  const hostAuthority = authority(host)
  if (!hostAuthority) return { ok: false, status: 403, code: 'UNTRUSTED_HOST' }

  const origin = singleHeader(req as IncomingMessage, 'origin')
  if (mutation && !origin) return { ok: false, status: 403, code: 'ORIGIN_REQUIRED' }
  if (origin) {
    const parsedOrigin = originAuthority(origin)
    if (!parsedOrigin || !sameAuthority(hostAuthority, parsedOrigin)) {
      return { ok: false, status: 403, code: 'CROSS_ORIGIN' }
    }
  }
  const site = singleHeader(req as IncomingMessage, 'sec-fetch-site')
  if (site !== undefined && site !== 'same-origin') {
    return { ok: false, status: 403, code: 'CROSS_SITE' }
  }
  const suppliedToken = singleHeader(req as IncomingMessage, 'x-nobei-spike-token')
  if (suppliedToken === undefined) return { ok: false, status: 403, code: 'SPIKE_TOKEN_REQUIRED' }
  if (!tokenMatches(suppliedToken, expectedToken)) {
    return { ok: false, status: 403, code: 'SPIKE_TOKEN_INVALID' }
  }
  return { ok: true }
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra?: Record<string, string>): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
    ...extra,
  })
  res.end(body)
}

function sendError(res: ServerResponse, status: number, code: string, extra?: Record<string, string>): void {
  sendJson(res, status, { ok: false, error: { code } }, extra)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
      length += chunk.byteLength
      if (length > BODY_LIMIT) {
        req.pause()
        throw new BodyError(413, 'BODY_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof BodyError) throw error
    throw new BodyError(400, 'BODY_READ_ERROR')
  }
  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
  } catch {
    throw new BodyError(400, 'INVALID_JSON')
  }
}

function hasExactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
}

export function registerSpikeRoutes(
  ctx: Context,
  operations: SpikeOperations,
  options: RouteOptions,
): () => void {
  let providerUsed = false
  return ctx.webServer.register({
    kind: 'prefix',
    path: '/nobei-spike/v1',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const health = url.pathname === '/nobei-spike/v1/health'
      const subprocess = url.pathname === '/nobei-spike/v1/subprocess'
      const provider = url.pathname === '/nobei-spike/v1/provider'
      if (!health && !subprocess && !provider) return sendError(res, 404, 'ROUTE_NOT_FOUND')
      const expectedMethod = health ? 'GET' : 'POST'
      if (req.method !== expectedMethod) {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', { allow: expectedMethod })
      }
      const decision = authorizeSpikeRequest(req, !health, options.token)
      if (!decision.ok) return sendError(res, decision.status, decision.code)
      if (health) return sendJson(res, 200, { ok: true, service: 'nobei-phase1a-spike' })

      const contentType = singleHeader(req, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') return sendError(res, 415, 'JSON_REQUIRED')
      try {
        const body = await readBody(req)
        if (subprocess && !hasExactKeys(body, [])) return sendError(res, 400, 'REQUEST_BODY_INVALID')
        if (provider) {
          if (!hasExactKeys(body, ['authorizationRequest', 'authorizationGrant'])) {
            return sendError(res, 400, 'REQUEST_BODY_INVALID')
          }
          try {
            const request = verifyAuthorizationRequest(body.authorizationRequest)
            verifyGrant(body.authorizationGrant, request)
          } catch {
            return sendError(res, 403, 'AUTHORIZATION_INVALID')
          }
          if (providerUsed) return sendError(res, 409, 'PROVIDER_PROBE_ALREADY_USED')
          providerUsed = true
        }

        const requestAbort = new AbortController()
        const abort = (): void => requestAbort.abort()
        req.once('aborted', abort)
        res.once('close', abort)
        try {
          const signal = AbortSignal.any([options.rootSignal, requestAbort.signal])
          const result = subprocess
            ? await operations.runSubprocess(signal)
            : await operations.runProvider(signal)
          req.off('aborted', abort)
          res.off('close', abort)
          if (!res.destroyed && !res.writableEnded) sendJson(res, 200, { ok: true, result })
        } finally {
          req.off('aborted', abort)
          res.off('close', abort)
        }
      } catch (error) {
        if (res.destroyed || res.writableEnded) return
        if (error instanceof BodyError) {
          return sendError(res, error.status, error.code, error.status === 413 ? { connection: 'close' } : undefined)
        }
        if (provider && error instanceof ProviderProbeError) {
          return sendJson(res, 500, {
            ok: false,
            error: {
              code: 'PROBE_FAILED',
              actualCalls: error.actualCalls,
              failureStage: error.failureStage,
            },
          })
        }
        return sendError(res, 500, 'PROBE_FAILED')
      }
    },
  })
}
