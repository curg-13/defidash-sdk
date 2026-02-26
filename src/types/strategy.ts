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
  // ─── Position Size ──────────────────────────────────────────────────────────
  /** Initial deposit value in USD */
  initialEquityUsd: number;

  /** Flash loan amount in USDC (raw, 6 decimals) */
  flashLoanUsdc: bigint;

  /** Flash loan fee in USD (Scallop: ~0.2-0.3% of flash loan) */
  flashLoanFeeUsd: number;

  /** Total position value after leverage (collateral USD) */
  totalPositionUsd: number;

  /** Total debt in USD (flash loan repayment) */
  debtUsd: number;

  // ─── Leverage & Risk ────────────────────────────────────────────────────────
  /** Effective multiplier achieved */
  effectiveMultiplier: number;

  /** Maximum allowed multiplier based on protocol LTV */
  maxMultiplier: number;

  /** Protocol LTV for this asset (0-1) */
  assetLtv: number;

  /** Position LTV percentage */
  ltvPercent: number;

  /** Liquidation threshold from protocol (0-1) */
  liquidationThreshold: number;

  /** Estimated liquidation price (USD per token) */
  liquidationPrice: number;

  /** Price drop buffer before liquidation (%) */
  priceDropBuffer: number;

  // ─── APY & Earnings ────────────────────────────────────────────────────────
  /** Supply APY breakdown for deposit asset */
  supplyApyBreakdown: {
    base: number;
    reward: number;
    total: number;
  };

  /** Borrow APY breakdown for borrow asset (USDC) */
  borrowApyBreakdown: {
    gross: number;
    rebate: number;
    net: number;
  };

  /**
   * Net position APY = (totalPosition × supplyApy - debt × borrowApy) / initialEquity
   * Represents annualized return on the initial equity.
   */
  netApy: number;

  /** Estimated annual net earnings in USD */
  annualNetEarningsUsd: number;

  // ─── Execution Costs ───────────────────────────────────────────────────────
  /** Estimated swap slippage % (from 7k quote or default estimate) */
  swapSlippagePct: number;
}
