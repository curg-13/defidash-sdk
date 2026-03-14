/**
 * SDK configuration types
 */

import { LendingProtocol } from "./common";

/**
 * SDK initialization options
 */
export interface SDKOptions {
  /** Sui RPC URL (defaults to mainnet) */
  rpcUrl?: string;

  /** Network environment */
  network?: "mainnet" | "testnet";

  /** 7k Protocol partner address (optional) */
  swapPartner?: string;
}

/**
 * Browser-compatible Leverage Parameters (no dryRun - handled externally)
 */
export interface BrowserLeverageParams {
  protocol: LendingProtocol;
  depositAsset: string;
  /** Amount to deposit (human-readable). Either this OR depositValueUsd must be provided. */
  depositAmount?: string;
  /** USD value to deposit. Either this OR depositAmount must be provided. */
  depositValueUsd?: number;
  multiplier: number;
  /**
   * Swap slippage tolerance in basis points (1 bp = 0.01%).
   * Default: 100 (1%)
   * @example 50 = 0.5%, 100 = 1%, 200 = 2%
   */
  slippageBps?: number;
}

/**
 * Browser-compatible Deleverage Parameters
 */
export interface BrowserDeleverageParams {
  protocol: LendingProtocol;
  /**
   * Swap slippage tolerance in basis points (1 bp = 0.01%).
   * Default: 500 (5%) - higher than leverage due to collateral → USDC swaps
   * @example 200 = 2%, 500 = 5%, 1000 = 10%
   */
  slippageBps?: number;
}
