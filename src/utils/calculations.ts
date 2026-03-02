/**
 * DeFi Dash SDK - Calculation Utilities
 *
 * Common calculations for DeFi strategies (leverage, deleverage, flash loans, etc.)
 */

import { formatUnits } from "./format";

/**
 * Convert amount from raw units to human-readable number
 *
 * Wrapper around formatUnits that returns a number instead of string.
 *
 * @param rawAmount - Raw amount (bigint or string)
 * @param decimals - Token decimals
 * @returns Human-readable number
 */
export function fromRawUnits(rawAmount: bigint | string, decimals: number): number {
  return parseFloat(formatUnits(rawAmount, decimals));
}

/**
 * Calculate liquidation metrics for a leveraged position
 *
 * @param debtUsd - Total debt in USD
 * @param collateralAmount - Total collateral in token units (human-readable)
 * @param liquidationThreshold - Liquidation threshold (0-1, e.g. 0.65)
 * @param currentPrice - Current asset price in USD
 * @returns Liquidation price and price drop buffer percentage
 */
export function calculateLiquidationMetrics(
  debtUsd: number,
  collateralAmount: number,
  liquidationThreshold: number,
  currentPrice: number,
): { liquidationPrice: number; priceDropBuffer: number } {
  const liquidationPrice =
    debtUsd / (collateralAmount * liquidationThreshold);
  const priceDropBuffer = (1 - liquidationPrice / currentPrice) * 100;
  return { liquidationPrice, priceDropBuffer };
}
