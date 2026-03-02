/**
 * DeFi Dash SDK - Leverage Preview
 *
 * Pure-calculation module for previewing a leveraged position without executing.
 */

import { SuiClient } from "@mysten/sui/client";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import {
  ILendingProtocol,
  LeveragePreview,
  COIN_TYPES,
} from "../types";
import { ScallopFlashLoanClient } from "../protocols/scallop/flash-loan";
import { parseUnits, getDecimals } from "../utils";
import { calculateLiquidationMetrics } from "../utils/calculations";
import { InvalidParameterError } from "../utils/errors";

// ── Dependency injection ─────────────────────────────────────────────────────

export interface PreviewLeverageDeps {
  protocol: ILendingProtocol;
  swapClient: MetaAg;
  suiClient: SuiClient;
}

export interface PreviewLeverageParams {
  coinType: string;
  depositAmount?: string;
  depositValueUsd?: number;
  multiplier: number;
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Calculate a full leverage-position preview.
 *
 * Includes risk params, APY breakdown, flash-loan fee (on-chain),
 * and swap slippage from a live 7k quote.
 */
export async function previewLeverage(
  params: PreviewLeverageParams,
  deps: PreviewLeverageDeps,
): Promise<LeveragePreview> {
  const { coinType, multiplier } = params;
  const { protocol, swapClient, suiClient } = deps;

  // ── Input validation ───────────────────────────────────────────────────────
  if (!params.depositAmount && !params.depositValueUsd) {
    throw new InvalidParameterError(
      "Either depositAmount or depositValueUsd must be provided",
    );
  }
  if (params.depositAmount && params.depositValueUsd) {
    throw new InvalidParameterError(
      "Cannot provide both depositAmount and depositValueUsd. Choose one.",
    );
  }

  const decimals = getDecimals(coinType);

  // ── Risk parameters ────────────────────────────────────────────────────────
  const riskParams = await protocol.getAssetRiskParams(coinType);

  if (multiplier > riskParams.maxMultiplier) {
    throw new InvalidParameterError(
      `Multiplier ${multiplier}x exceeds protocol max ${riskParams.maxMultiplier.toFixed(2)}x`,
    );
  }

  // ── Deposit amount resolution ──────────────────────────────────────────────
  let depositAmountStr: string;
  const price = await getTokenPrice(coinType);
  if (params.depositValueUsd) {
    const amountInToken = params.depositValueUsd / price;
    depositAmountStr = amountInToken.toFixed(decimals);
  } else {
    depositAmountStr = params.depositAmount!;
  }

  const depositAmount = parseUnits(depositAmountStr, decimals);
  const depositAmountHuman = Number(depositAmount) / Math.pow(10, decimals);
  const initialEquityUsd = depositAmountHuman * price;

  // ── Flash loan calculation ─────────────────────────────────────────────────
  const flashLoanUsd = initialEquityUsd * (multiplier - 1);
  const flashLoanUsdc = BigInt(Math.ceil(flashLoanUsd * 1e6));

  const flashLoanFeeRate = await ScallopFlashLoanClient.fetchFlashLoanFeeRate(
    suiClient,
    COIN_TYPES.USDC,
  );
  const flashLoanFeeUsd = (Number(flashLoanUsdc) / 1e6) * flashLoanFeeRate;

  const totalPositionUsd = initialEquityUsd * multiplier;
  const debtUsd = flashLoanUsd + flashLoanFeeUsd;
  const ltvPercent = (debtUsd / totalPositionUsd) * 100;

  // ── Liquidation ────────────────────────────────────────────────────────────
  const totalCollateralAmount = depositAmountHuman * multiplier;
  const { liquidationPrice, priceDropBuffer } = calculateLiquidationMetrics(
    debtUsd,
    totalCollateralAmount,
    riskParams.liquidationThreshold,
    price,
  );

  // ── APY & Earnings ─────────────────────────────────────────────────────────
  const depositApy = await protocol.getAssetApy(coinType);

  const usdcCoinType = COIN_TYPES.USDC;
  const borrowApyData = await protocol.getAssetApy(usdcCoinType);

  const annualSupplyEarnings = totalPositionUsd * depositApy.totalSupplyApy;
  const annualBorrowCost = debtUsd * borrowApyData.borrowApy;
  const annualNetEarningsUsd = annualSupplyEarnings - annualBorrowCost;
  const netApy =
    initialEquityUsd > 0 ? annualNetEarningsUsd / initialEquityUsd : 0;

  // ── Swap slippage (7k quote) ───────────────────────────────────────────────
  let swapSlippagePct = 1.0;
  let effectiveMultiplier = multiplier;

  const swapQuotes = await swapClient.quote({
    amountIn: flashLoanUsdc.toString(),
    coinTypeIn: COIN_TYPES.USDC,
    coinTypeOut: coinType,
  });

  if (swapQuotes.length > 0) {
    const bestQuote = [...swapQuotes].sort(
      (a: any, b: any) => Number(b.amountOut) - Number(a.amountOut),
    )[0];

    const actualAmountOut =
      Number(bestQuote.amountOut) / Math.pow(10, decimals);
    const theoreticalAmountOut = Number(flashLoanUsdc) / 1e6 / price;

    if (theoreticalAmountOut > 0) {
      const slippageRatio =
        (theoreticalAmountOut - actualAmountOut) / theoreticalAmountOut;
      swapSlippagePct = Math.max(0, slippageRatio * 100);
    }

    const actualTotalToken = depositAmountHuman + actualAmountOut;
    effectiveMultiplier =
      actualAmountOut > 0
        ? actualTotalToken / depositAmountHuman
        : multiplier;
  }

  return {
    initialEquityUsd,
    flashLoanUsdc,
    flashLoanFeeUsd,
    totalPositionUsd,
    debtUsd,
    effectiveMultiplier,
    maxMultiplier: riskParams.maxMultiplier,
    assetLtv: riskParams.ltv,
    ltvPercent,
    liquidationThreshold: riskParams.liquidationThreshold,
    liquidationPrice,
    priceDropBuffer,
    supplyApyBreakdown: {
      base: depositApy.supplyApy,
      reward: depositApy.rewardApy,
      total: depositApy.totalSupplyApy,
    },
    borrowApyBreakdown: {
      gross: borrowApyData.borrowApy + borrowApyData.borrowRewardApy,
      rebate: borrowApyData.borrowRewardApy,
      net: borrowApyData.borrowApy,
    },
    netApy,
    annualNetEarningsUsd,
    swapSlippagePct,
  };
}
