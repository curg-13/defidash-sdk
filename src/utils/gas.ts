/**
 * DeFi Dash SDK - Gas Optimization Utilities
 *
 * Gas calculation and optimization helpers for Sui transactions.
 */


/**
 * Fixed gas budget for dry runs (0.2 SUI - enough for complex leverage operations)
 */
export const DRYRUN_GAS_BUDGET = 200_000_000;

/**
 * Default gas buffer percentage (20%)
 */
export const DEFAULT_GAS_BUFFER_PERCENT = 20;

/**
 * Gas usage details from transaction execution
 */
export interface GasUsed {
  computationCost: string;
  storageCost: string;
  storageRebate: string;
}

/**
 * Calculate actual gas cost from gas usage details
 *
 * @param gasUsed - Gas usage breakdown from transaction effects
 * @returns Actual gas cost (computation + storage - rebate)
 */
export function calculateActualGas(gasUsed: GasUsed): bigint {
  const computationCost = BigInt(gasUsed.computationCost);
  const storageCost = BigInt(gasUsed.storageCost);
  const storageRebate = BigInt(gasUsed.storageRebate);
  const net = computationCost + storageCost - storageRebate;
  return net > 0n ? net : 0n;
}

/**
 * Calculate optimized gas budget with buffer
 *
 * @param actualGas - Actual gas cost from dry run
 * @param bufferPercent - Buffer percentage (default: 20%)
 * @returns Optimized gas budget with buffer
 */
export function calculateOptimizedBudget(
  actualGas: bigint,
  bufferPercent: number = DEFAULT_GAS_BUFFER_PERCENT,
): bigint {
  const multiplier = BigInt(100 + bufferPercent);
  return (actualGas * multiplier) / 100n;
}

