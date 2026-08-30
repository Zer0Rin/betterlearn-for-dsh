import { Readable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import {
  authorizeProductRequest,
  parseProductJsonBody,
  requestHasBody,
} from '../src/product/request-security.js'

function request(overrides: Record<string, unknown> = {}) {
  return {
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
    },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  } as never
}

describe('product request security', () => {
  test.each(['127.0.0.1', '127.9.8.7', '::1', '::ffff:127.0.0.1'])(
    'accepts loopback address %s',
    (remoteAddress) => {
      expect(authorizeProductRequest(request({ socket: { remoteAddress } }), true, 3_080))
        .toEqual({ ok: true })
    },
  )

  test.each([
    ['remote address', { socket: { remoteAddress: '203.0.113.1' } }, 'LOOPBACK_REQUIRED'],
    ['non-loopback Host', { headers: { host: 'evil.example', origin: 'http://evil.example', 'sec-fetch-site': 'same-origin' } }, 'UNTRUSTED_HOST'],
    ['wrong listener port', { headers: { host: '127.0.0.1:9999', origin: 'http://127.0.0.1:9999', 'sec-fetch-site': 'same-origin' } }, 'UNTRUSTED_HOST'],
    ['missing mutation Origin', { headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } }, 'ORIGIN_REQUIRED'],
    ['cross Origin', { headers: { host: '127.0.0.1:3080', origin: 'http://localhost:3080', 'sec-fetch-site': 'same-origin' } }, 'CROSS_ORIGIN'],
    ['cross-site metadata', { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }, 'CROSS_SITE'],
    ['duplicate Host', { headers: { host: ['127.0.0.1:3080', 'localhost:3080'], origin: 'http://127.0.0.1:3080' } }, 'AMBIGUOUS_HEADER'],
  ])('rejects %s', (_name, override, code) => {
    expect(authorizeProductRequest(request(override), true, 3_080))
      .toEqual({ ok: false, status: 403, code })
  })

  test('allows a GET without Origin but rejects observable request bodies', () => {
    const get = request({ headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } })
    expect(authorizeProductRequest(get, false, 3_080)).toEqual({ ok: true })
    expect(requestHasBody({ headers: { 'content-length': '1' } } as never)).toBe(true)
    expect(requestHasBody({ headers: { 'transfer-encoding': 'chunked' } } as never)).toBe(true)
    expect(requestHasBody({ headers: {} } as never)).toBe(false)
  })

  test('parses exactly the 512 KiB boundary and rejects +1', async () => {
    const exactText = 'x'.repeat(512 * 1024 - 11)
    const exact = Readable.from([Buffer.from(JSON.stringify({ text: exactText }))])
    await expect(parseProductJsonBody(exact as never)).resolves.toEqual({ text: exactText })
    const overText = 'x'.repeat(512 * 1024 - 10)
    const over = Readable.from([Buffer.from(JSON.stringify({ text: overText }))])
    await expect(parseProductJsonBody(over as never)).rejects.toMatchObject({
      status: 413, code: 'BODY_TOO_LARGE',
    })
  })

  test.each([
    ['invalid JSON', '{', 'INVALID_JSON'],
    ['duplicate key', '{"runId":"a","runId":"b"}', 'DUPLICATE_JSON_KEY'],
    ['stream error', null, 'BODY_READ_ERROR'],
  ])('rejects %s', async (_name, body, code) => {
    const input = body === null
      ? new Readable({ read() { this.destroy(new Error('canary stream detail')) } })
      : Readable.from([body])
    await expect(parseProductJsonBody(input as never)).rejects.toMatchObject({ code })
  })
})
