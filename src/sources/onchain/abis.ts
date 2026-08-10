import { parseAbi } from 'viem'

/** Shared by every adapter that reads a vault share rate. */
export const erc4626Abi = parseAbi([
  'function asset() view returns (address)',
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function convertToShares(uint256 assets) view returns (uint256)',
  'function maxDeposit(address receiver) view returns (uint256)',
  'function previewRedeem(uint256 shares) view returns (uint256)',
])
