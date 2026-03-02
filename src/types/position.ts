/**
 * Position and portfolio types
 */

import { LendingProtocol, PositionSide } from "./common";

/**
 * Asset position details
 */
export interface AssetPosition {
  /** Raw amount in token units */
  amount: bigint;

  /** Token symbol (e.g., "LBTC", "USDC") */
  symbol: string;

  /** Coin type (full address) */
  coinType: string;

  /** Token decimals */
  decimals: number;

  /** USD value */
  valueUsd: number;
}

/**
 * Current lending position information
 */
export interface PositionInfo {
  /** Primary collateral — largest supply by USD value */
  collateral: AssetPosition;

  /** Primary debt — largest borrow by USD value */
  debt: AssetPosition;

  /** All supply positions (includes dust) */
  supplies: AssetPosition[];

  /** All borrow positions */
  borrows: AssetPosition[];

  /** Net value in USD (total supplies - total borrows) */
  netValueUsd: number;

  /** Health factor (> 1 is safe, < 1 is liquidatable) */
  healthFactor?: number;

  /** Current LTV percentage */
  ltvPercent?: number;

  /** Liquidation price of collateral */
  liquidationPrice?: number;

  /** Total deposited USD */
  totalDepositedUsd?: number;

  /** Weighted borrows USD (for health factor calculation) */
  weightedBorrowsUsd?: number;

  /** Borrow limit USD */
  borrowLimitUsd?: number;

  /** Liquidation threshold USD */
  liquidationThresholdUsd?: number;
}

/**
 * User position for a single asset (Supply or Borrow)
 */
export interface Position {
  protocol: LendingProtocol;
  coinType: string;
  symbol: string;
  side: PositionSide;
  amount: number;
  /** Raw on-chain amount */
  amountRaw?: string;
  valueUsd: number;
  apy: number;
  /** Rewards APY component */
  rewardsApy?: number;
  /** Earned rewards details */
  rewards?: { symbol: string; amount: number; valueUsd?: number }[];
  /** Estimated liquidation price for collateral (if supply side) */
  estimatedLiquidationPrice?: number;
}

/**
 * Aggregated account portfolio for a protocol
 */
export interface AccountPortfolio {
  protocol: LendingProtocol;
  address: string;
  healthFactor: number;

  netValueUsd: number;
  totalCollateralUsd: number;
  totalDebtUsd: number;

  /** Total deposited USD */
  totalDepositedUsd?: number;

  /** Weighted borrows USD (for health factor calculation) */
  weightedBorrowsUsd?: number;

  /** Borrow limit USD */
  borrowLimitUsd?: number;

  /** Liquidation threshold USD */
  liquidationThresholdUsd?: number;

  positions: Position[];

  /** Net APY on Equity (Annualized return % on net value) */
  netApy?: number;

  /** Estimated Annual Net Earnings in USD */
  totalAnnualNetEarningsUsd?: number;
}

/**
 * Market data for a single asset
 */
export interface MarketAsset {
  symbol: string;
  coinType: string;
  decimals: number;
  price: number;
  supplyApy: number;
  borrowApy: number;
  maxLtv: number;
  liquidationThreshold: number;
  totalSupply: number;
  totalBorrow: number;
  availableLiquidity: number;
}
