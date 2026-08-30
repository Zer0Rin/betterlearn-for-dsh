import type { IncomingMessage } from 'node:http'
import { PRODUCT_BODY_LIMIT_BYTES } from './constants.js'

interface Authority {
  hostname: string
  port: number
}

export type ProductRequestDecision =
  | { ok: true }
  | { ok: false; status: 403; code: string }

export class ProductRequestError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string) {
    super(code)
    this.name = 'ProductRequestError'
  }
}

function loopback(raw: string): string | undefined {
  const value = raw.toLowerCase()
  if (value === 'localhost' || value === '::1' || value === '[::1]') return value
  const ipv4 = /^(127)\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (ipv4 && ipv4.slice(2).every((part) => Number(part) <= 255)) return value
  const mapped = /^(?:\[)?::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\])?$/.exec(value)
  return mapped && loopback(mapped[1]) ? value : undefined
}

function singleHeader(req: Pick<IncomingMessage, 'headers'>, name: string): string | undefined | null {
  const value = req.headers[name]
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function parseAuthority(raw: string | undefined, expectedPort: number): Authority | undefined {
  if (!raw) return undefined
  try {
    const value = new URL(`http://${raw}`)
    if (value.username || value.password || value.pathname !== '/' || value.search || value.hash) return undefined
    const hostname = loopback(value.hostname)
    const port = value.port === '' ? 80 : Number(value.port)
    if (!hostname || port !== expectedPort) return undefined
    return { hostname, port }
  } catch {
    return undefined
  }
}

function parseOrigin(raw: string, expectedPort: number): Authority | undefined {
  try {
    const value = new URL(raw)
    if (value.protocol !== 'http:' || value.pathname !== '/' || value.search || value.hash) return undefined
    return parseAuthority(value.host, expectedPort)
  } catch {
    return undefined
  }
}

export function authorizeProductRequest(
  req: Pick<IncomingMessage, 'headers' | 'socket'>,
  mutation: boolean,
  listenerPort: number,
): ProductRequestDecision {
  if (!loopback(req.socket.remoteAddress ?? '')) {
    return { ok: false, status: 403, code: 'LOOPBACK_REQUIRED' }
  }
  const hostValue = singleHeader(req, 'host')
  const originValue = singleHeader(req, 'origin')
  const siteValue = singleHeader(req, 'sec-fetch-site')
  if (hostValue === null || originValue === null || siteValue === null) {
    return { ok: false, status: 403, code: 'AMBIGUOUS_HEADER' }
  }
  const host = parseAuthority(hostValue, listenerPort)
  if (!host) return { ok: false, status: 403, code: 'UNTRUSTED_HOST' }
  if (mutation && originValue === undefined) {
    return { ok: false, status: 403, code: 'ORIGIN_REQUIRED' }
  }
  if (originValue !== undefined) {
    const origin = parseOrigin(originValue, listenerPort)
    if (!origin || origin.hostname !== host.hostname || origin.port !== host.port) {
      return { ok: false, status: 403, code: 'CROSS_ORIGIN' }
    }
  }
  if (siteValue !== undefined && siteValue !== 'same-origin') {
    return { ok: false, status: 403, code: 'CROSS_SITE' }
  }
  return { ok: true }
}

export function requestHasBody(req: Pick<IncomingMessage, 'headers'>): boolean {
  const length = singleHeader(req, 'content-length')
  const transfer = singleHeader(req, 'transfer-encoding')
  if (length === null || transfer === null) return true
  return transfer !== undefined || (length !== undefined && length !== '0')
}

function hasDuplicateRootKey(source: string): boolean {
  let objectDepth = 0
  let arrayDepth = 0
  const keys = new Set<string>()
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') { objectDepth += 1; continue }
    if (character === '}') { objectDepth -= 1; continue }
    if (character === '[') { arrayDepth += 1; continue }
    if (character === ']') { arrayDepth -= 1; continue }
    if (character !== '"') continue
    const start = index
    index += 1
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue }
      if (source[index] === '"') break
      index += 1
    }
    if (objectDepth !== 1 || arrayDepth !== 0) continue
    let cursor = index + 1
    while (/\s/.test(source[cursor] ?? '')) cursor += 1
    if (source[cursor] !== ':') continue
    let key: string
    try {
      key = JSON.parse(source.slice(start, index + 1)) as string
    } catch {
      continue
    }
    if (keys.has(key)) return true
    keys.add(key)
  }
  return false
}

export async function parseProductJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  try {
    for await (const raw of req) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array)
      length += chunk.byteLength
      if (length > PRODUCT_BODY_LIMIT_BYTES) {
        req.pause()
        throw new ProductRequestError(413, 'BODY_TOO_LARGE')
      }
      chunks.push(chunk)
    }
  } catch (error) {
    if (error instanceof ProductRequestError) throw error
    throw new ProductRequestError(400, 'BODY_READ_ERROR')
  }
  const source = Buffer.concat(chunks, length).toString('utf8')
  if (hasDuplicateRootKey(source)) throw new ProductRequestError(400, 'DUPLICATE_JSON_KEY')
  try {
    return JSON.parse(source)
  } catch {
    throw new ProductRequestError(400, 'INVALID_JSON')
  }
}
