/**
 * DeFi Dash SDK - Gas Optimization Utilities
 *
 * Gas calculation and optimization helpers for Sui transactions.
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";

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
  return computationCost + storageCost - storageRebate;
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

/**
 * Result of dry run with gas optimization
 */
export interface DryRunResult {
  success: boolean;
  optimizedBudget?: bigint;
  error?: string;
}

/**
 * Dry run a transaction and calculate optimized gas budget
 *
 * This function:
 * 1. Sets a large fixed gas budget for dry run
 * 2. Executes dry run simulation
 * 3. Calculates actual gas used
 * 4. Returns optimized budget with buffer
 *
 * @param client - Sui client instance
 * @param tx - Transaction to dry run
 * @param bufferPercent - Gas buffer percentage (default: 20%)
 * @returns Dry run result with optimized budget
 */
export async function dryRunAndOptimizeGas(
  client: SuiClient,
  tx: Transaction,
  bufferPercent: number = DEFAULT_GAS_BUFFER_PERCENT,
): Promise<DryRunResult> {
  // Set fixed budget for dry run
  tx.setGasBudget(DRYRUN_GAS_BUDGET);

  try {
    const result = await client.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client }),
    });

    if (result.effects.status.status !== "success") {
      return {
        success: false,
        error: result.effects.status.error || "Dry run failed",
      };
    }

    const actualGas = calculateActualGas(result.effects.gasUsed);
    const optimizedBudget = calculateOptimizedBudget(actualGas, bufferPercent);

    return {
      success: true,
      optimizedBudget,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Dry run failed",
    };
  }
}

/**
 * Check if user has sufficient balance for gas
 *
 * @param client - Sui client instance
 * @param userAddress - User's Sui address
 * @param requiredGas - Required gas amount
 * @returns True if user has sufficient balance
 */
export async function checkGasBalance(
  client: SuiClient,
  userAddress: string,
  requiredGas: bigint,
): Promise<{ sufficient: boolean; userBalance: bigint }> {
  const balance = await client.getBalance({ owner: userAddress });
  const userBalance = BigInt(balance.totalBalance);

  return {
    sufficient: userBalance >= requiredGas,
    userBalance,
  };
}
