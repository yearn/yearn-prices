import { type Address, parseAbi } from 'viem'
import {
  blockEvidence,
  childTarget,
  contractContext,
  erc20Abi,
  type OnchainAdapterOptions,
  rawState,
  recursiveInput,
  tokenDecimals
} from '../context'
import { InvalidPricingError } from '../errors'
import { calculateWrapperPrice } from '../math'
import { type PlannedPriceAdapter, plannedAdapter } from '../plan'

const WRAPPER = '0x27f2f159fe990ba83d57f39fd69661764bebf37a'
const COMET = '0xc3d688b66703497daa19211eedff47f25384cdc3' as Address
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48' as Address
const wrapperAbi = parseAbi([
  'function underlyingComet() view returns (address)',
  'function convertStaticToDynamic(uint104 amount) view returns (uint256)'
])
const cometAbi = parseAbi([
  'function baseToken() view returns (address)',
  'function userBasic(address) view returns (int104 principal, uint64 baseTrackingIndex, uint64 baseTrackingAccrued, uint16 assetsIn, uint8 reserved)',
  'function isTransferPaused() view returns (bool)',
  'function isWithdrawPaused() view returns (bool)'
])

/** Reserve's reviewed, non-rebasing cUSDCv3 wrapper. Shares are Comet principal,
 * not cToken V2 exchange-rate units. Use its accrued historical conversion;
 * compare backing in principal units to avoid mixing stored/accrued indices.
 * https://github.com/reserve-protocol/protocol/blob/9ee60f142f9f5c1fe8bc50eef915cf33124a534f/contracts/plugins/assets/compoundv3/CusdcV3Wrapper.sol
 */
export function compoundV3WrapperAdapter(options: OnchainAdapterOptions): PlannedPriceAdapter {
  return plannedAdapter('compound-v3-static-wrapper', async (target) => {
    if (target.chainId !== 1 || target.token.toLowerCase() !== WRAPPER) return null
    const state = await contractContext(target, options)
    const { client, blockNumber, address } = state
    const [comet, base, shareDecimals, baseDecimals, totalSupplyRaw, backing, transferPaused, withdrawPaused, cashRaw] =
      await Promise.all([
        client.readContract({ address, abi: wrapperAbi, functionName: 'underlyingComet', blockNumber }),
        client.readContract({ address: COMET, abi: cometAbi, functionName: 'baseToken', blockNumber }),
        tokenDecimals(client, address, blockNumber),
        tokenDecimals(client, USDC, blockNumber),
        client.readContract({ address, abi: erc20Abi, functionName: 'totalSupply', blockNumber }),
        client.readContract({ address: COMET, abi: cometAbi, functionName: 'userBasic', args: [address], blockNumber }),
        client.readContract({ address: COMET, abi: cometAbi, functionName: 'isTransferPaused', blockNumber }),
        client.readContract({ address: COMET, abi: cometAbi, functionName: 'isWithdrawPaused', blockNumber }),
        client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [COMET], blockNumber })
      ])
    if (comet.toLowerCase() !== COMET || base.toLowerCase() !== USDC || shareDecimals !== 6 || baseDecimals !== 6)
      throw new InvalidPricingError('Compound v3 wrapper identity or decimals mismatch')
    if (transferPaused || withdrawPaused) throw new InvalidPricingError('Compound v3 wrapper redemption is paused')
    if (totalSupplyRaw <= 0n || backing[0] < totalSupplyRaw)
      throw new InvalidPricingError('Compound v3 wrapper has insufficient principal backing')
    const oneShareRaw = 10n ** BigInt(shareDecimals)
    const convertedAssetsRaw = await client.readContract({
      address,
      abi: wrapperAbi,
      functionName: 'convertStaticToDynamic',
      args: [oneShareRaw],
      blockNumber
    })
    if (convertedAssetsRaw <= 0n || cashRaw < convertedAssetsRaw)
      throw new InvalidPricingError('Compound v3 wrapper has insufficient base redemption liquidity')
    const metadata = {
      ...blockEvidence(state, target),
      method: 'convertStaticToDynamic',
      comet: COMET,
      underlying: USDC,
      valuationRule: 'principal-backed-static-comet-conversion',
      oneShareRaw: rawState(oneShareRaw),
      convertedAssetsRaw: rawState(convertedAssetsRaw),
      totalSupplyRaw: rawState(totalSupplyRaw),
      backingPrincipalRaw: rawState(backing[0]),
      cashRaw: rawState(cashRaw),
      shareDecimals,
      baseDecimals
    }
    return {
      dependencies: [{ target: childTarget(target, USDC, state.numericBlockNumber), label: 'Compound v3 base asset' }],
      metadata,
      evaluate([input]) {
        return {
          priceUsd: calculateWrapperPrice(convertedAssetsRaw, baseDecimals, oneShareRaw, shareDecimals, input.priceUsd),
          blockNumber: state.numericBlockNumber,
          inputs: [recursiveInput(input, metadata)],
          metadata
        }
      }
    }
  })
}
