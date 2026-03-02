/**
 * DeFi Dash SDK - Common Strategy Utilities
 *
 * Shared computation and lookup functions used by leverage/deleverage strategies.
 */

import { MetaAg } from "@7kprotocol/sdk-ts";
import { COIN_TYPES } from "../types";
import { normalizeCoinType } from "../utils";

// ── Scallop coin-name mapping ────────────────────────────────────────────────

const SCALLOP_COIN_NAME_MAP: Record<string, string> = {
  [COIN_TYPES.SUI]: "sui",
  [COIN_TYPES.USDC]: "usdc",
  [COIN_TYPES.wUSDC]: "wusdc",
  [COIN_TYPES.wUSDT]: "wusdt",
};

/**
 * Resolve a full coin type to the Scallop SDK coin name
 * (e.g. "0x2::sui::SUI" → "sui", "0x…::usdc::USDC" → "usdc").
 */
export function getScallopCoinName(coinType: string): string {
  const normalized = normalizeCoinType(coinType);
  return (
    SCALLOP_COIN_NAME_MAP[normalized] ||
    normalized.split("::").pop()?.toLowerCase() ||
    "sui"
  );
}

/**
 * Buffer multiplier for borrow interest that accrues immediately.
 * Applied to the flash loan repayment amount to ensure we borrow enough.
 */
export const BORROW_FEE_BUFFER = 1.005;

// ── Leverage amount calculations ─────────────────────────────────────────────

export interface LeverageAmounts {
  flashLoanUsdc: bigint;
  flashLoanFee: bigint;
  repaymentAmount: bigint;
  borrowAmount: bigint;
}

/**
 * Pure computation of flash-loan and borrow amounts for a leverage loop.
 *
 * @param initialEquityUsd  User deposit value in USD
 * @param multiplier        Target leverage multiplier (e.g. 2.0)
 * @param calculateFeeFn    Fee calculator (default: ScallopFlashLoanClient.calculateFee)
 * @param borrowFeeBuffer   Multiplier buffer for borrow-interest accrual (default 1.003)
 */
export function computeLeverageAmounts(
  initialEquityUsd: number,
  multiplier: number,
  calculateFeeFn: (amount: bigint) => bigint,
  borrowFeeBuffer = BORROW_FEE_BUFFER,
): LeverageAmounts {
  const flashLoanUsd = initialEquityUsd * (multiplier - 1);
  const flashLoanUsdc = BigInt(Math.ceil(flashLoanUsd * 1e6));
  const flashLoanFee = calculateFeeFn(flashLoanUsdc);
  const repaymentAmount = flashLoanUsdc + flashLoanFee;
  const borrowAmount = BigInt(
    Math.ceil(Number(repaymentAmount) * borrowFeeBuffer),
  );

  return { flashLoanUsdc, flashLoanFee, repaymentAmount, borrowAmount };
}

// ── Swap-quote helper ────────────────────────────────────────────────────────

export interface BestSwapQuote {
  quote: any;
  amountOut: bigint;
}

/**
 * Fetch swap quotes and return the best (highest amountOut).
 *
 * @throws if no valid quotes are returned
 */
export async function findBestSwapQuote(
  swapClient: MetaAg,
  amountIn: string,
  coinTypeIn: string,
  coinTypeOut: string,
  label?: string,
): Promise<BestSwapQuote> {
  let quotes: any[];
  try {
    quotes = await swapClient.quote({
      amountIn,
      coinTypeIn,
      coinTypeOut,
    });
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    throw new Error(
      `Swap quote failed${label ? ` for ${label}` : ""}: ${msg}`,
    );
  }

  if (quotes.length === 0) {
    throw new Error(
      `No swap quotes found${label ? ` for ${label}` : ""}`,
    );
  }

  // Filter out quotes with zero output (invalid routes)
  const validQuotes = quotes.filter(
    (q: any) => BigInt(q.amountOut) > 0n,
  );

  if (validQuotes.length === 0) {
    throw new Error(
      `All swap quotes returned zero output${label ? ` for ${label}` : ""}`,
    );
  }

  const best = [...validQuotes].sort(
    (a: any, b: any) => Number(b.amountOut) - Number(a.amountOut),
  )[0];

  return { quote: best, amountOut: BigInt(best.amountOut) };
}
