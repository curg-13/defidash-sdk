/**
 * Strategy parameters and results
 */

import { LendingProtocol } from "./common";
import { PositionInfo } from "./position";

/**
 * Parameters for leverage strategy
 */
export interface LeverageParams {
  /** Target lending protocol */
  protocol: LendingProtocol;

  /** Asset to deposit as collateral (symbol like 'LBTC' or full coin type) */
  depositAsset: string;

  /**
   * Amount to deposit (human-readable, e.g., "0.001")
   * Either depositAmount OR depositValueUsd must be provided, not both.
   */
  depositAmount?: string;

  /**
   * USD value to deposit (e.g., 1.0 for $1 worth of the asset)
   * Either depositAmount OR depositValueUsd must be provided, not both.
   * The SDK will automatically convert this to the appropriate amount based on current price.
   */
  depositValueUsd?: number;

  /** Leverage multiplier (e.g., 1.5, 2.0, 3.0) */
  multiplier: number;

  /** If true, only simulate the transaction */
  dryRun?: boolean;
}

/**
 * Parameters for deleverage strategy
 */
export interface DeleverageParams {
  /** Target lending protocol to close position on */
  protocol: LendingProtocol;

  /** If true, only simulate the transaction */
  dryRun?: boolean;
}

/**
 * Result of strategy execution
 */
export interface StrategyResult {
  /** Whether the strategy succeeded */
  success: boolean;

  /** Transaction digest (if executed) */
  txDigest?: string;

  /** Resulting position info */
  position?: PositionInfo;

  /** Gas used (in MIST) */
  gasUsed?: bigint;

  /** Error message (if failed) */
  error?: string;
}

/**
 * Preview of leverage position before execution
 */
export interface LeveragePreview {
  /** Initial deposit value in USD */
  initialEquityUsd: number;

  /** Flash loan amount in USDC */
  flashLoanUsdc: bigint;

  /** Total position value after leverage */
  totalPositionUsd: number;

  /** Total debt in USD */
  debtUsd: number;

  /** Effective multiplier achieved */
  effectiveMultiplier: number;

  /** Position LTV percentage */
  ltvPercent: number;

  /** Estimated liquidation price */
  liquidationPrice: number;

  /** Price drop buffer before liquidation */
  priceDropBuffer: number;
}
