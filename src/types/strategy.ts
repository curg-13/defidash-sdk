/**
 * Strategy parameters and results
 */

import { LendingProtocol } from "./common";
import { PositionInfo } from "./position";

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

/**
 * Input parameters for findBestLeverageRoute.
 * No protocol or multiplier needed — the method discovers the best ones.
 */
export interface FindBestRouteParams {
  /** Asset to deposit as collateral (symbol like 'SUI' or full coin type) */
  depositAsset: string;

  /** Amount to deposit (human-readable). Either this OR depositValueUsd must be provided. */
  depositAmount?: string;

  /** USD value to deposit. Either this OR depositAmount must be provided. */
  depositValueUsd?: number;
}

/**
 * A single recommended route with its protocol and full preview data
 */
export interface LeverageRoute {
  /** Which protocol this route uses */
  protocol: LendingProtocol;

  /** The multiplier used for this preview */
  multiplier: number;

  /** Full preview data from previewLeverage */
  preview: LeveragePreview;
}

/**
 * Result of findBestLeverageRoute.
 *
 * Contains two recommended routes:
 * - bestMaxMultiplier: the protocol offering the highest possible leverage
 * - bestApy: the protocol with the highest net APY at a safe multiplier
 */
export interface LeverageRouteResult {
  /** Route with the highest maxMultiplier for this asset */
  bestMaxMultiplier: LeverageRoute;

  /** Route with the best netApy at the safe comparison multiplier */
  bestApy: LeverageRoute;

  /** The safe multiplier used for APY comparison (min maxMultiplier - buffer) */
  safeMultiplier: number;

  /** All successful previews at the safe multiplier (for display / comparison) */
  allPreviews: Array<{ protocol: LendingProtocol; preview: LeveragePreview }>;

  /** Protocols that failed (for debugging) */
  failedProtocols: Array<{ protocol: LendingProtocol; error: string }>;
}
