/**
 * DeFi Dash SDK - Calculation Utilities
 *
 * Common calculations for DeFi strategies (leverage, deleverage, flash loans, etc.)
 */

import { ScallopFlashLoanClient } from "../protocols/scallop/flash-loan";
import { parseUnits, formatUnits } from "./format";

/**
 * Flash loan parameters
 */
export interface FlashLoanParams {
  /** Amount to borrow */
  borrowAmount: bigint;
  /** Flash loan fee */
  fee: bigint;
  /** Total amount to repay (borrowAmount + fee) */
  totalRepayment: bigint;
}

/**
 * Deleverage calculation result
 */
export interface DeleverageCalculation {
  /** Amount of collateral to swap */
  swapAmount: bigint;
  /** Amount of collateral to keep */
  keepAmount: bigint;
  /** Expected USDC output from swap */
  expectedUsdcOut: bigint;
  /** Estimated profit in USDC */
  estimatedProfit: bigint;
  /** Flash loan parameters */
  flashLoan: FlashLoanParams;
}

/**
 * Leverage calculation result
 */
export interface LeverageCalculation {
  /** Flash loan amount in USDC (raw units, 6 decimals) */
  flashLoanUsdc: bigint;
  /** Amount of deposit asset expected from swap */
  expectedAssetOut: bigint;
  /** Total deposit amount (user deposit + swapped amount) */
  totalDeposit: bigint;
  /** Amount to borrow for flash loan repayment */
  borrowAmount: bigint;
  /** Flash loan parameters */
  flashLoan: FlashLoanParams;
}

/**
 * Calculate flash loan parameters
 *
 * @param amount - Amount to borrow
 * @param bufferPercent - Buffer percentage to add (e.g., 0.5 for 0.5%)
 * @returns Flash loan parameters
 */
export function calculateFlashLoanParams(
  amount: bigint,
  bufferPercent: number = 0.5,
): FlashLoanParams {
  // Add buffer for interest accrual
  const bufferMultiplier = BigInt(Math.floor((100 + bufferPercent) * 10));
  const borrowAmount = (amount * bufferMultiplier) / 1000n;

  const fee = ScallopFlashLoanClient.calculateFee(borrowAmount);
  const totalRepayment = borrowAmount + fee;

  return {
    borrowAmount,
    fee,
    totalRepayment,
  };
}

/**
 * Calculate optimal swap amount for deleverage
 *
 * Given a collateral amount and debt to repay, calculates how much
 * collateral needs to be swapped to cover the debt while keeping
 * as much collateral as possible.
 *
 * @param collateralAmount - Total collateral amount (raw units)
 * @param debtAmount - Debt to repay (raw units)
 * @param swapRate - Expected output per input (from quote)
 * @param bufferPercent - Buffer percentage (e.g., 2 for 2%)
 * @returns Swap and keep amounts
 */
export function calculateDeleverageSwapAmount(
  collateralAmount: bigint,
  debtAmount: bigint,
  swapRateNumerator: bigint,
  swapRateDenominator: bigint,
  bufferPercent: number = 2,
): { swapAmount: bigint; keepAmount: bigint } {
  // Target output = debt + buffer
  const bufferMultiplier = BigInt(Math.floor((100 + bufferPercent) * 100));
  const targetOutput = (debtAmount * bufferMultiplier) / 10000n;

  // Calculate required input: input = target / rate
  // rate = numerator / denominator
  // input = target * denominator / numerator
  const requiredInput = (targetOutput * swapRateDenominator) / swapRateNumerator;

  // Cap at total collateral
  const swapAmount = requiredInput > collateralAmount ? collateralAmount : requiredInput;
  const keepAmount = collateralAmount - swapAmount;

  return { swapAmount, keepAmount };
}

/**
 * Calculate leverage parameters
 *
 * @param depositValueUsd - Initial deposit value in USD
 * @param multiplier - Target leverage multiplier
 * @param assetPriceUsd - Asset price in USD
 * @param assetDecimals - Asset decimals
 * @returns Leverage calculation
 */
export function calculateLeverageParams(
  depositValueUsd: number,
  multiplier: number,
  assetPriceUsd: number,
  assetDecimals: number,
): { flashLoanUsd: number; flashLoanUsdc: bigint; expectedAssetAmount: bigint } {
  // Flash loan = deposit * (multiplier - 1)
  const flashLoanUsd = depositValueUsd * (multiplier - 1);

  // Convert to USDC raw units (6 decimals) with 2% buffer
  const flashLoanUsdc = BigInt(Math.ceil(flashLoanUsd * 1e6 * 1.02));

  // Expected asset amount = flash loan USD / asset price
  const expectedAssetHuman = flashLoanUsd / assetPriceUsd;
  const expectedAssetAmount = BigInt(
    Math.floor(expectedAssetHuman * Math.pow(10, assetDecimals)),
  );

  return {
    flashLoanUsd,
    flashLoanUsdc,
    expectedAssetAmount,
  };
}

/**
 * Calculate position metrics
 *
 * @param collateralValueUsd - Total collateral value in USD
 * @param debtValueUsd - Total debt value in USD
 * @param collateralPrice - Collateral asset price in USD
 * @param liquidationThreshold - Liquidation LTV (e.g., 0.85 for 85%)
 * @returns Position metrics
 */
export function calculatePositionMetrics(
  collateralValueUsd: number,
  debtValueUsd: number,
  collateralPrice: number,
  liquidationThreshold: number = 0.85,
): {
  ltvPercent: number;
  healthFactor: number;
  liquidationPrice: number;
  priceDropBuffer: number;
  netValueUsd: number;
  effectiveMultiplier: number;
} {
  const netValueUsd = collateralValueUsd - debtValueUsd;
  const ltvPercent = debtValueUsd > 0 ? (debtValueUsd / collateralValueUsd) * 100 : 0;
  const healthFactor = debtValueUsd > 0 ? collateralValueUsd / debtValueUsd : Infinity;

  // Liquidation price = current price * (debt / (collateral * threshold))
  const liquidationPrice =
    debtValueUsd > 0
      ? collateralPrice * (debtValueUsd / (collateralValueUsd * liquidationThreshold))
      : 0;

  // Price drop buffer = (current price - liquidation price) / current price
  const priceDropBuffer =
    liquidationPrice > 0 ? (collateralPrice - liquidationPrice) / collateralPrice : 1;

  // Effective multiplier = collateral / (collateral - debt)
  const effectiveMultiplier = netValueUsd > 0 ? collateralValueUsd / netValueUsd : 1;

  return {
    ltvPercent,
    healthFactor,
    liquidationPrice,
    priceDropBuffer,
    netValueUsd,
    effectiveMultiplier,
  };
}

/**
 * Convert amount from human-readable to raw units
 *
 * Wrapper around parseUnits that accepts both number and string input.
 *
 * @param humanAmount - Human-readable amount (e.g., 1.5 or "1.5")
 * @param decimals - Token decimals
 * @returns Raw amount as bigint
 */
export function toRawUnits(humanAmount: number | string, decimals: number): bigint {
  const amountStr = typeof humanAmount === "number" ? humanAmount.toString() : humanAmount;
  return parseUnits(amountStr, decimals);
}

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
 * Check if an amount string is in human-readable format
 * (contains decimal point or is a small number)
 *
 * @param amountStr - Amount string to check
 * @param threshold - Threshold for considering as human-readable (default: 1000)
 * @returns true if human-readable format
 */
export function isHumanReadableAmount(amountStr: string, threshold: number = 1000): boolean {
  return amountStr.includes(".") || parseFloat(amountStr) < threshold;
}

/**
 * Parse amount from environment variable, handling both human-readable and raw formats
 *
 * @param amountStr - Amount string (human-readable or raw)
 * @param decimals - Token decimals
 * @returns Raw amount as bigint
 */
export function parseEnvAmount(amountStr: string, decimals: number): bigint {
  if (isHumanReadableAmount(amountStr)) {
    return toRawUnits(amountStr, decimals);
  }
  return BigInt(amountStr);
}

/**
 * Calculate minimum amount after slippage
 *
 * @param amount - Expected amount
 * @param slippageBps - Slippage in basis points (100 = 1%)
 * @returns Minimum amount after slippage
 */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  return (amount * BigInt(10000 - slippageBps)) / 10000n;
}

/**
 * Add buffer to an amount (for interest, fees, etc.)
 *
 * @param amount - Base amount
 * @param bufferPercent - Buffer percentage (e.g., 2 for 2%)
 * @returns Amount with buffer
 */
export function withBuffer(amount: bigint, bufferPercent: number): bigint {
  const multiplier = BigInt(Math.floor((100 + bufferPercent) * 100));
  return (amount * multiplier) / 10000n;
}
