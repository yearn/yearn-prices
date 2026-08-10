import { parseAbi, type Address } from 'viem'
import {
  blockEvidence,
  contractContext,
  erc20Abi,
  maybe,
  normalizedAddress,
  rawState,
  recursiveInput,
  requireChildren,
  tokenDecimals,
  type OnchainAdapterOptions,
} from '../context'
import { calculatePoolNavPrice } from '../math'
import type { RecursivePriceAdapter } from '../types'

const CANONICAL_VAULT = '0xba12222222228d8ba445958a75a0704d566bf2c8'
const VAULTS: Record<number, string> = {
  1: CANONICAL_VAULT,
  10: CANONICAL_VAULT,
  100: CANONICAL_VAULT,
  137: CANONICAL_VAULT,
  250: '0x20dd72ed959b6147912c2e529f0a0c651c33c9ce',
  42161: CANONICAL_VAULT,
}

const poolAbi = parseAbi(['function getPoolId() view returns (bytes32)'])
const vaultAbi = parseAbi([
  'function getPoolTokens(bytes32 poolId) view returns (address[] tokens, uint256[] balances, uint256 lastChangeBlock)',
])

export function balancerAdapter(options: OnchainAdapterOptions): RecursivePriceAdapter {
  return {
    name: 'balancer-v2-vault-nav',
    async resolve(target, context) {
      const state = await contractContext(target, options)
      const vaultAddress = VAULTS[state.chainId]
      if (!vaultAddress) {
        return null
      }
      const poolId = await maybe(() =>
        state.client.readContract({
          address: state.address,
          abi: poolAbi,
          functionName: 'getPoolId',
          blockNumber: state.blockNumber,
        }),
      )
      if (!poolId) {
        return null
      }

      const [poolTokens, poolDecimals, totalSupplyRaw] = await Promise.all([
        state.client.readContract({
          address: vaultAddress as Address,
          abi: vaultAbi,
          functionName: 'getPoolTokens',
          args: [poolId],
          blockNumber: state.blockNumber,
        }),
        tokenDecimals(state.client, target.token, state.blockNumber),
        state.client.readContract({
          address: state.address,
          abi: erc20Abi,
          functionName: 'totalSupply',
          blockNumber: state.blockNumber,
        }),
      ])

      const targetAddress = target.token.toLowerCase()
      const assets = poolTokens[0].map((address, index) => ({
        address: normalizedAddress(address) ?? address,
        balanceRaw: poolTokens[1][index],
      }))
      // Composable pools hold their own BPT; that balance is pre-minted supply,
      // not a constituent, so it is excluded from both NAV and supply.
      const selfAsset = assets.find((asset) => asset.address.toLowerCase() === targetAddress)
      const constituents = assets.filter((asset) => asset.address.toLowerCase() !== targetAddress)
      if (constituents.length === 0) {
        return null
      }

      const [decimals, inputs] = await Promise.all([
        Promise.all(
          constituents.map((asset) => tokenDecimals(state.client, asset.address, state.blockNumber)),
        ),
        requireChildren(
          context,
          target,
          constituents.map((asset) => asset.address),
          state.numericBlockNumber,
          'Balancer constituent',
        ),
      ])
      const selfBalanceRaw = selfAsset?.balanceRaw ?? 0n
      const metadata = {
        ...blockEvidence(state, target),
        vaultAddress,
        poolId,
        valuationRule: 'all-constituents-required',
        totalSupplyRaw: rawState(totalSupplyRaw),
        excludedPremintedPoolTokensRaw: rawState(selfBalanceRaw),
        poolDecimals,
        lastChangeBlock: poolTokens[2].toString(),
        tokens: constituents.map((asset, index) => ({
          address: asset.address,
          decimals: decimals[index],
          balanceRaw: rawState(asset.balanceRaw),
        })),
      }
      return {
        priceUsd: calculatePoolNavPrice(
          constituents.map((asset, index) => ({
            ...asset,
            decimals: decimals[index],
            priceUsd: inputs[index].priceUsd,
          })),
          totalSupplyRaw,
          poolDecimals,
          selfBalanceRaw,
        ),
        blockNumber: state.numericBlockNumber,
        inputs: inputs.map((path, index) =>
          recursiveInput(path, {
            method: 'balancer-vault-nav',
            balanceRaw: rawState(constituents[index].balanceRaw),
            decimals: decimals[index],
          }),
        ),
        metadata,
      }
    },
  }
}
