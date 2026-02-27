/**
 * DeFi Dash SDK - Common Strategy Utilities
 *
 * Shared computation and lookup functions used by leverage/deleverage strategies.
 */

import { MetaAg } from "@7kprotocol/sdk-ts";
import { normalizeCoinType } from "../utils";

// ── Scallop coin-name mapping ────────────────────────────────────────────────

const SCALLOP_COIN_NAME_MAP: Record<string, string> = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI":
    "sui",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    "usdc",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN":
    "wusdc",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN":
    "wusdt",
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
  borrowFeeBuffer = 1.003,
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
 * @throws if no quotes are returned
 */
export async function findBestSwapQuote(
  swapClient: MetaAg,
  amountIn: string,
  coinTypeIn: string,
  coinTypeOut: string,
  label?: string,
): Promise<BestSwapQuote> {
  const quotes = await swapClient.quote({
    amountIn,
    coinTypeIn,
    coinTypeOut,
  });

  if (quotes.length === 0) {
    throw new Error(
      `No swap quotes found${label ? ` for ${label}` : ""}`,
    );
  }

  const best = quotes.sort(
    (a: any, b: any) => Number(b.amountOut) - Number(a.amountOut),
  )[0];

  return { quote: best, amountOut: BigInt(best.amountOut) };
}
