import { describe, expect, test, vi } from 'vitest'
import {
  RpcConfigurationError,
  validateConfiguredRpcChainIds,
  validateRpcChainId,
} from '../src/rpc'

function rpcResponse(result: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('RPC chain ID validation', () => {
  test('accepts the expected chain ID', async () => {
    const request = vi.fn().mockResolvedValue(rpcResponse('0xfa'))
    await expect(validateRpcChainId(250, 'https://user:secret@example.invalid', { request }))
      .resolves.toBeUndefined()
  })

  test('rejects a different numeric chain ID without exposing the endpoint', async () => {
    const url = 'https://user:secret@example.invalid/private'
    const request = vi.fn().mockResolvedValue(rpcResponse('0x92'))
    const error = await validateRpcChainId(250, url, { request }).catch(value => value)

    expect(error).toBeInstanceOf(RpcConfigurationError)
    expect(error).toMatchObject({
      expectedChainId: 250,
      returnedChainId: 146,
      failure: 'mismatch',
    })
    expect(error.message).toContain('expected 250, received 146')
    expect(error.message).not.toContain(url)
    expect(error.message).not.toContain('user')
    expect(error.message).not.toContain('secret')
  })

  test('keeps a missing RPC distinct', async () => {
    const error = await validateRpcChainId(250, undefined).catch(value => value)
    expect(error).toMatchObject({ failure: 'missing', expectedChainId: 250, returnedChainId: null })
    expect(error.message).toBe('RPC_URL_250 is not configured')
  })

  test('sanitizes transport failures as configuration errors', async () => {
    const request = vi.fn().mockRejectedValue(new Error('fetch failed for https://user:secret@example.invalid'))
    const error = await validateRpcChainId(250, 'https://user:secret@example.invalid', { request })
      .catch(value => value)

    expect(error).toMatchObject({ failure: 'transport', expectedChainId: 250, returnedChainId: null })
    expect(error.message).not.toContain('example.invalid')
    expect(error.message).not.toContain('secret')
  })

  test('validates only supported RPC keys that are present', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(rpcResponse('0x1'))
      .mockResolvedValueOnce(rpcResponse('0xfa'))
      .mockResolvedValueOnce(rpcResponse('0x3e7'))
    await validateConfiguredRpcChainIds({
      RPC_URL_1: 'https://ethereum.invalid',
      RPC_URL_250: 'https://fantom.invalid',
      RPC_URL_999: 'https://hyperevm.invalid',
    }, { request })

    expect(request).toHaveBeenCalledTimes(3)
  })
})
