import { BlockNotFoundError, type PublicClient } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { estimateBlockByTimestamp, getChainClient, rpcCooldownDelay, rpcUrlsForChain } from '../../src/clients/rpc'

const GENESIS = 1_600_000_000
const BLOCK_TIME = 12
const LATEST = 1_000n

function timestampOf(block: bigint): number {
  return GENESIS + Number(block) * BLOCK_TIME
}

// One block every BLOCK_TIME seconds, so the right answer for any timestamp is
// known in closed form. Chain ids are unique per test: the block cache and the
// sample memo are module-level state shared across tests.
function fakeChain(): PublicClient {
  return {
    async getBlock(args?: { blockNumber?: bigint }) {
      const number = args?.blockNumber ?? LATEST
      return { number, timestamp: BigInt(timestampOf(number)) }
    }
  } as unknown as PublicClient
}

// The binary search sleeps between steps; drive the fake clock until it settles.
async function drain<T>(work: Promise<T>): Promise<T> {
  let done = false
  void work.then(
    () => {
      done = true
    },
    () => {
      done = true
    }
  )
  while (!done) {
    await vi.advanceTimersByTimeAsync(10)
  }
  return work
}

describe('estimateBlockByTimestamp', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns the block minted at the exact timestamp', async () => {
    const block = await estimateBlockByTimestamp(fakeChain(), 910_001, timestampOf(500n))

    expect(block).toBe(500n)
  })

  it('returns the last block at or before a timestamp between blocks', async () => {
    const block = await estimateBlockByTimestamp(fakeChain(), 910_002, timestampOf(500n) + 5)

    expect(block).toBe(500n)
  })

  it('returns the latest block for a future timestamp', async () => {
    const block = await estimateBlockByTimestamp(fakeChain(), 910_003, timestampOf(LATEST) + 1)

    expect(block).toBe(LATEST)
  })

  it('answers from warmed samples exactly as a cold search would', async () => {
    const client = fakeChain()
    await estimateBlockByTimestamp(client, 910_004, timestampOf(200n) + 3)
    await estimateBlockByTimestamp(client, 910_004, timestampOf(800n))

    const warm = await estimateBlockByTimestamp(client, 910_004, timestampOf(600n) + 1)
    const cold = await estimateBlockByTimestamp(fakeChain(), 910_005, timestampOf(600n) + 1)

    expect(warm).toBe(600n)
    expect(warm).toBe(cold)
  })

  it('serves a repeated timestamp from the block cache without new reads', async () => {
    let reads = 0
    const client = {
      async getBlock(args?: { blockNumber?: bigint }) {
        reads += 1
        const number = args?.blockNumber ?? LATEST
        return { number, timestamp: BigInt(timestampOf(number)) }
      }
    } as unknown as PublicClient

    const first = await estimateBlockByTimestamp(client, 910_006, timestampOf(300n) + 1)
    const readsAfterFirst = reads
    const second = await estimateBlockByTimestamp(client, 910_006, timestampOf(300n) + 1)

    expect(second).toBe(first)
    expect(reads).toBe(readsAfterFirst)
  })

  it('returns genesis for a timestamp older than the whole chain', async () => {
    const block = await estimateBlockByTimestamp(fakeChain(), 910_007, GENESIS - 1)

    expect(block).toBe(0n)
  })

  it('searches past blocks the provider cannot serve', async () => {
    const client = {
      async getBlock(args?: { blockNumber?: bigint }) {
        const number = args?.blockNumber ?? LATEST
        if (number < 600n) throw new BlockNotFoundError({ blockNumber: number })
        return { number, timestamp: BigInt(timestampOf(number)) }
      }
    } as unknown as PublicClient

    await expect(estimateBlockByTimestamp(client, 910_020, timestampOf(700n) + 1)).resolves.toBe(700n)
    await expect(estimateBlockByTimestamp(client, 910_020, timestampOf(100n))).rejects.toBeInstanceOf(
      BlockNotFoundError
    )
  })

  it('lands on the same block as a linear scan when block times are irregular', async () => {
    // Monotone but uneven spacing, which is what a real chain looks like.
    const timestamps: number[] = [GENESIS]
    for (let index = 1; index <= Number(LATEST); index += 1) {
      timestamps.push(timestamps[index - 1] + ((index * 7919) % 29) + 1)
    }
    const irregularChain = (): PublicClient =>
      ({
        async getBlock(args?: { blockNumber?: bigint }) {
          const number = args?.blockNumber ?? LATEST
          return { number, timestamp: BigInt(timestamps[Number(number)]) }
        }
      }) as unknown as PublicClient
    const scan = (timestamp: number): bigint => {
      let best = 0n
      for (let index = 0; index <= Number(LATEST); index += 1) {
        if (timestamps[index] <= timestamp) best = BigInt(index)
      }
      return best
    }

    const targets = [timestamps[137] + 1, timestamps[42], timestamps[900] - 2, timestamps[7] + 5]
    const warmClient = irregularChain()
    for (const target of targets) {
      expect(await estimateBlockByTimestamp(irregularChain(), 910_100 + target, target)).toBe(scan(target))
      // Same chain id throughout: every later lookup runs off warmed samples.
      expect(await estimateBlockByTimestamp(warmClient, 910_200, target)).toBe(scan(target))
    }
  })

  it('evicts the oldest block-cache entry once the cap is passed', async () => {
    // Fake timers: the search paces itself with a real 10ms sleep per step.
    vi.useFakeTimers()
    // Short chain, wide blocks: 600 settled timestamps cost a 3-read search each.
    const SPARSE_LATEST = 8n
    const SPARSE_BLOCK_TIME = 10_000
    let reads = 0
    const client = {
      async getBlock(args?: { blockNumber?: bigint }) {
        reads += 1
        const number = args?.blockNumber ?? SPARSE_LATEST
        return { number, timestamp: BigInt(GENESIS + Number(number) * SPARSE_BLOCK_TIME) }
      }
    } as unknown as PublicClient
    const oldest = GENESIS
    const fill = (async () => {
      for (let index = 0; index < 600; index += 1) {
        await estimateBlockByTimestamp(client, 910_300, oldest + index)
      }
    })()
    await drain(fill)

    const readsBefore = reads
    await estimateBlockByTimestamp(client, 910_300, oldest + 599)
    expect(reads).toBe(readsBefore)

    await drain(estimateBlockByTimestamp(client, 910_300, oldest))
    expect(reads).toBeGreaterThan(readsBefore)
  })

  it('never caches a head-block answer, so a later request sees the advanced chain', async () => {
    let head = LATEST
    const client = {
      async getBlock(args?: { blockNumber?: bigint }) {
        const number = args?.blockNumber ?? head
        return { number, timestamp: BigInt(timestampOf(number)) }
      }
    } as unknown as PublicClient
    // End of the current day: ahead of the head block before and after it advances.
    const today = timestampOf(LATEST) + 86_400

    expect(await estimateBlockByTimestamp(client, 910_400, today)).toBe(LATEST)
    head = LATEST + 10n
    expect(await estimateBlockByTimestamp(client, 910_400, today)).toBe(LATEST + 10n)
  })
})

describe('getChainClient', () => {
  it.each(['ftp://bad.test', 'not a url'])('disables RPC sources for invalid configuration: %s', (url) => {
    expect(getChainClient(1, { RPC_URL_1: url })).toBeNull()
  })

  it('disables RPC sources when too many endpoints are configured', () => {
    const urls = Array.from({ length: 17 }, (_, i) => `https://rpc${i}.test`)
    expect(getChainClient(1, { RPC_URLS_1: JSON.stringify(urls) })).toBeNull()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('honors Retry-After up to the one-hour operational ceiling', () => {
    const now = 1_700_000_000_000

    expect(rpcCooldownDelay(429, '7', now)).toBe(7_000)
    expect(rpcCooldownDelay(503, new Date(now + 12_000).toUTCString(), now)).toBe(12_000)
    expect(rpcCooldownDelay(500, '60', now)).toBe(0)
    expect(rpcCooldownDelay(429, '999999999', now)).toBe(3_600_000)
  })

  it('skips a rate-limited primary on subsequent reads while the backup works', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('primary.cooldown.test')) {
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '3600' } })
      }
      const payload = JSON.parse(String(init?.body))
      const answer = (request: { id: number }) => ({ jsonrpc: '2.0', id: request.id, result: '0x1234' })
      return Response.json(Array.isArray(payload) ? payload.map(answer) : answer(payload))
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = getChainClient(1, {
      RPC_URL_1: 'https://primary.cooldown.test',
      RPC_URLS_1: '["https://backup.cooldown.test"]'
    })!
    await expect(client.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1234')
    await expect(client.request({ method: 'eth_blockNumber' })).resolves.toBe('0x1234')
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('primary.cooldown.test'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('backup.cooldown.test'))).toHaveLength(2)
  })

  it('keeps the singular URL first and merges canonicalized JSON backups', () => {
    const urls = rpcUrlsForChain(1, {
      RPC_URL_1: ' HTTPS://RPC.EXAMPLE/primary/#ignored ',
      RPC_URLS_1: '["https://rpc.example/backup/", "https://rpc.example/primary/"]'
    })

    expect(urls).toEqual(['https://rpc.example/primary/', 'https://rpc.example/backup/'])
  })

  it('accepts comma and newline-delimited backup URLs', () => {
    expect(
      rpcUrlsForChain(1, {
        RPC_URLS_1: 'https://rpc.example/one,\n https://rpc.example/two'
      })
    ).toEqual(['https://rpc.example/one', 'https://rpc.example/two'])
  })

  it('rejects non-http(s) archive endpoints', () => {
    expect(() => rpcUrlsForChain(1, { RPC_URLS_1: '["ftp://rpc.example/archive"]' })).toThrow('http:// or https://')
  })

  it('memoizes per chain and rpc url', () => {
    const env = { RPC_URL_1: 'https://rpc.example/one' }

    expect(getChainClient(1, env)).toBe(getChainClient(1, env))
  })

  it('does not hand one env rpc url to a caller with a different one', () => {
    const first = getChainClient(1, { RPC_URL_1: 'https://rpc.example/first' })
    const second = getChainClient(1, { RPC_URL_1: 'https://rpc.example/second' })

    expect(first).not.toBe(second)
    expect(first?.chain?.rpcUrls.default.http[0]).toBe('https://rpc.example/first')
    expect(second?.chain?.rpcUrls.default.http[0]).toBe('https://rpc.example/second')
  })

  it('memoizes the complete ordered URL set and exposes all endpoints on the chain', () => {
    const env = {
      RPC_URL_1: 'https://rpc.example/primary',
      RPC_URLS_1: '["https://rpc.example/backup"]'
    }
    const client = getChainClient(1, env)

    expect(client?.chain?.rpcUrls.default.http).toEqual(['https://rpc.example/primary', 'https://rpc.example/backup'])
    expect(client).toBe(getChainClient(1, env))
    expect(client).not.toBe(
      getChainClient(1, {
        RPC_URL_1: 'https://rpc.example/primary',
        RPC_URLS_1: '["https://rpc.example/other"]'
      })
    )
  })

  it('returns null when the env has no binding for the chain', () => {
    expect(getChainClient(1, { DATABASE_URL: 'x' })).toBeNull()
  })

  it('reads process.env only when no worker env is passed', () => {
    expect(getChainClient(10)).toBeNull()
  })
})
