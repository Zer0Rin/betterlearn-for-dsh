import { PassThrough } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { JsonlRpcClient } from '../src/spike/jsonl-rpc.js'

function pair(timeoutMs = 100): {
  client: JsonlRpcClient
  input: PassThrough
  output: PassThrough
} {
  const input = new PassThrough()
  const output = new PassThrough()
  return { client: new JsonlRpcClient(input, output, { timeoutMs }), input, output }
}

describe('bounded JSONL-RPC framing', () => {
  test('assembles fragmented lines and separates multiple lines per chunk', async () => {
    const { client, input } = pair()
    const ready = client.waitForNotification('core.ready')
    input.write('{"jsonrpc":"2.0","method":"core.')
    input.write('ready","params":{"protocolVersion":1}}\n')
    await expect(ready).resolves.toEqual({ protocolVersion: 1 })

    const first = client.request('echo', { value: 1 })
    const second = client.request('echo', { value: 2 })
    input.write(
      '{"jsonrpc":"2.0","id":1,"result":{"value":1}}\n'
      + '{"jsonrpc":"2.0","id":2,"result":{"value":2}}\n',
    )
    await expect(first).resolves.toEqual({ value: 1 })
    await expect(second).resolves.toEqual({ value: 2 })
  })

  test.each([
    ['unknown response id', '{"jsonrpc":"2.0","id":99,"result":{}}\n', 'JSONL_RPC_UNKNOWN_ID'],
    ['malformed JSON', '{broken}\n', 'JSONL_RPC_MALFORMED_JSON'],
    ['oversized line', `${'x'.repeat(65_537)}\n`, 'JSONL_RPC_LINE_TOO_LARGE'],
  ])('fails pending requests on %s', async (_name, line, code) => {
    const { client, input } = pair()
    const pending = client.request('echo', {})
    input.write(line)
    await expect(pending).rejects.toThrow(code)
  })

  test('fails on a duplicate response id', async () => {
    const { client, input } = pair()
    const first = client.request('echo', {})
    input.write('{"jsonrpc":"2.0","id":1,"result":{}}\n')
    await first
    const pending = client.request('echo', {})
    input.write('{"jsonrpc":"2.0","id":1,"result":{}}\n')
    await expect(pending).rejects.toThrow('JSONL_RPC_DUPLICATE_ID')
  })

  test('times out and aborts a pending request', async () => {
    const { client } = pair(10)
    await expect(client.request('echo', {})).rejects.toThrow('JSONL_RPC_TIMEOUT')
  })

  test('rejects pending requests when stdout reaches EOF', async () => {
    const { client, input } = pair()
    const pending = client.request('echo', {})
    input.end()
    await expect(pending).rejects.toThrow('JSONL_RPC_EOF')
  })
})
