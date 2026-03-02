/**
 * DeFi Dash SDK - Transaction Execution Utilities
 *
 * Standalone functions for dry-running and executing Sui transactions
 * with gas optimization.
 */

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { StrategyResult } from '../types';
import {
  DRYRUN_GAS_BUDGET,
  calculateActualGas,
  calculateOptimizedBudget,
} from './gas';

/**
 * Dry run a transaction with gas optimization
 *
 * Simulates the transaction and returns estimated gas usage.
 * Does NOT execute the transaction on-chain.
 *
 * @param client - Sui client instance
 * @param tx - Built transaction to simulate
 * @returns Strategy result with gas estimate
 */
export async function dryRunTransaction(
  client: SuiClient,
  tx: Transaction,
): Promise<StrategyResult> {
  tx.setGasBudget(DRYRUN_GAS_BUDGET);

  const result = await client.dryRunTransactionBlock({
    transactionBlock: await tx.build({ client }),
  });

  if (result.effects.status.status === 'success') {
    const actualGas = calculateActualGas(result.effects.gasUsed);
    const optimizedBudget = calculateOptimizedBudget(actualGas);

    return {
      success: true,
      gasUsed: optimizedBudget,
    };
  }

  return {
    success: false,
    error: result.effects.status.error || 'Dry run failed',
  };
}

/**
 * Execute a transaction with gas optimization (Node.js only)
 *
 * Flow:
 * 1. Check user balance for gas
 * 2. Dryrun with budget to get actual gas usage
 * 3. Calculate optimized budget (actual + 20% buffer)
 * 4. Execute with optimized budget
 *
 * @param client - Sui client instance
 * @param keypair - Ed25519 keypair for signing
 * @param userAddress - User's Sui address
 * @param tx - Built transaction to execute
 * @returns Strategy result with transaction digest and gas used
 */
export async function executeTransaction(
  client: SuiClient,
  keypair: Ed25519Keypair,
  userAddress: string,
  tx: Transaction,
): Promise<StrategyResult> {
  // Step 1: Check user's available gas balance
  const balance = await client.getBalance({ owner: userAddress });
  const userBalance = BigInt(balance.totalBalance);

  // Step 2: Set dryrun budget (use available balance or default, whichever is lower)
  const dryrunBudget =
    userBalance < BigInt(DRYRUN_GAS_BUDGET)
      ? userBalance
      : BigInt(DRYRUN_GAS_BUDGET);

  if (dryrunBudget < 10_000_000n) {
    return {
      success: false,
      error: `Insufficient balance for gas. Have: ${Number(userBalance) / 1e9} SUI`,
    };
  }

  tx.setGasBudget(dryrunBudget);

  const dryRunResult = await client.dryRunTransactionBlock({
    transactionBlock: await tx.build({ client }),
  });

  if (dryRunResult.effects.status.status !== 'success') {
    return {
      success: false,
      error: `Dry run failed: ${dryRunResult.effects.status.error}`,
    };
  }

  // Step 3: Calculate optimized gas budget (actual + 20% buffer)
  const actualGas = calculateActualGas(dryRunResult.effects.gasUsed);
  const optimizedBudget = calculateOptimizedBudget(actualGas);

  if (userBalance < optimizedBudget) {
    return {
      success: false,
      error: `Insufficient balance for gas. Need: ${Number(optimizedBudget) / 1e9} SUI, Have: ${Number(userBalance) / 1e9} SUI`,
    };
  }

  // Step 4: Execute with optimized gas budget
  tx.setGasBudget(optimizedBudget);

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: {
      showEffects: true,
    },
  });

  if (result.effects?.status.status === 'success') {
    return {
      success: true,
      txDigest: result.digest,
      gasUsed: BigInt(result.effects.gasUsed.computationCost),
    };
  }

  return {
    success: false,
    txDigest: result.digest,
    error: result.effects?.status.error || 'Execution failed',
  };
}
