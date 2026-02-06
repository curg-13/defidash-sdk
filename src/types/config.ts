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

  /**
   * Secret key for Scallop SDK (optional)
   *
   * Required for Scallop leverage/deleverage operations.
   * Can be in bech32 format (suiprivkey...) or base64.
   */
  secretKey?: string;
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
}

/**
 * Browser-compatible Deleverage Parameters
 */
export interface BrowserDeleverageParams {
  protocol: LendingProtocol;
}
