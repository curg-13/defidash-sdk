/**
 * DeFi Dash SDK - Scallop Leverage Transaction Builder
 *
 * Builds leverage transactions using the native Scallop SDK builder,
 * which handles oracle price updates via updateAssetPricesQuick.
 */

import { SuiClient } from "@mysten/sui/client";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { COIN_TYPES } from "../types";
import { parseUnits } from "../utils";
import { getReserveByCoinType } from "../protocols/suilend/constants";
import { ScallopFlashLoanClient } from "../protocols/scallop/flash-loan";
import {
  getScallopCoinName,
  computeLeverageAmounts,
  findBestSwapQuote,
} from "./common";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScallopLeverageBuildParams {
  coinType: string;
  depositAmount?: string;
  depositValueUsd?: number;
  multiplier: number;
  userAddress: string;
  secretKey: string;
}

export interface ScallopLeverageDeps {
  suiClient: SuiClient;
  swapClient: MetaAg;
}

export interface ScallopLeverageBuildResult {
  /** Scallop txBlock (builder.createTxBlock()) — call `builder.signAndSendTxBlock(tx)` to execute */
  tx: any;
  /** Scallop builder instance (needed for signAndSendTxBlock) */
  builder: any;
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Build a Scallop leverage transaction using the native Scallop SDK builder.
 *
 * Returns the built txBlock and builder so the caller can handle
 * dry-run / execution logic.
 */
export async function buildScallopLeverageTransaction(
  params: ScallopLeverageBuildParams,
  deps: ScallopLeverageDeps,
): Promise<ScallopLeverageBuildResult> {
  const { coinType, multiplier, userAddress, secretKey } = params;
  const { suiClient, swapClient } = deps;

  const reserve = getReserveByCoinType(coinType);
  const decimals = reserve?.decimals || 9;
  const symbol = coinType.split("::").pop()?.toUpperCase() || "SUI";
  const isSui = coinType.endsWith("::sui::SUI");
  const coinName = getScallopCoinName(coinType);

  // ── Deposit amount ─────────────────────────────────────────────────────────
  let depositAmountStr: string;
  if (params.depositValueUsd) {
    const price = await getTokenPrice(coinType);
    depositAmountStr = (params.depositValueUsd / price).toFixed(decimals);
  } else {
    depositAmountStr = params.depositAmount!;
  }
  const depositAmountRaw = parseUnits(depositAmountStr, decimals);
  const depositAmountHuman = parseFloat(depositAmountStr);

  // ── Leverage amounts ───────────────────────────────────────────────────────
  const depositPrice = await getTokenPrice(coinType);
  const initialEquityUsd = depositAmountHuman * depositPrice;

  const { flashLoanUsdc, borrowAmount } = computeLeverageAmounts(
    initialEquityUsd,
    multiplier,
    ScallopFlashLoanClient.calculateFee,
    1.003,
  );

  // ── Initialize Scallop SDK ─────────────────────────────────────────────────
  const scallop = new Scallop({
    secretKey,
    networkType: "mainnet",
  });
  await scallop.init();

  const builder = await scallop.createScallopBuilder();
  const client = await scallop.createScallopClient();
  const tx = builder.createTxBlock();
  tx.setSender(userAddress);

  // ── Check existing obligation ──────────────────────────────────────────────
  const existingObligations = await client.getObligations();
  const hasExistingObligation = existingObligations.length > 0;
  let existingObligationId: string | null = null;
  let existingObligationKeyId: string | null = null;
  let isCurrentlyLocked = false;

  if (hasExistingObligation) {
    existingObligationId = existingObligations[0].id;
    existingObligationKeyId = existingObligations[0].keyId;
    isCurrentlyLocked = existingObligations[0].locked;
  }

  // ── Swap quote ─────────────────────────────────────────────────────────────
  const { quote: bestQuote } = await findBestSwapQuote(
    swapClient,
    flashLoanUsdc.toString(),
    COIN_TYPES.USDC,
    coinType,
    `USDC \u2192 ${symbol}`,
  );

  // ── Build PTB ──────────────────────────────────────────────────────────────

  // Step 1: Flash loan USDC
  const [loanCoin, receipt] = await tx.borrowFlashLoan(
    Number(flashLoanUsdc),
    "usdc",
  );

  // Step 2: Swap USDC → deposit asset
  const swappedAsset = await swapClient.swap(
    {
      quote: bestQuote,
      signer: userAddress,
      coinIn: loanCoin,
      tx: tx.txBlock,
    },
    100,
  );

  // Step 3: Prepare deposit coin
  let depositCoin: any;
  if (isSui) {
    const [userDeposit] = tx.splitSUIFromGas([Number(depositAmountRaw)]);
    tx.mergeCoins(userDeposit, [swappedAsset]);
    depositCoin = userDeposit;
  } else {
    const userCoins = await suiClient.getCoins({
      owner: userAddress,
      coinType,
    });

    if (userCoins.data.length === 0) {
      throw new Error(`No ${symbol} coins in wallet`);
    }

    const primaryCoin = tx.txBlock.object(userCoins.data[0].coinObjectId);
    if (userCoins.data.length > 1) {
      const otherCoins = userCoins.data
        .slice(1)
        .map((c: any) => tx.txBlock.object(c.coinObjectId));
      tx.mergeCoins(primaryCoin, otherCoins);
    }

    const [userContribution] = tx.splitCoins(primaryCoin, [
      Number(depositAmountRaw),
    ]);
    tx.mergeCoins(userContribution, [swappedAsset]);
    depositCoin = userContribution;
  }

  // Step 4: Handle obligation
  let obligation: any;
  let obligationKey: any;
  let obligationHotPotato: any;
  let isNewObligation = false;

  if (
    hasExistingObligation &&
    existingObligationId &&
    existingObligationKeyId
  ) {
    obligation = tx.txBlock.object(existingObligationId);
    obligationKey = tx.txBlock.object(existingObligationKeyId);

    if (isCurrentlyLocked) {
      tx.unstakeObligation(obligation, obligationKey);
    }

    tx.addCollateral(obligation, depositCoin, coinName);
  } else {
    [obligation, obligationKey, obligationHotPotato] = tx.openObligation();
    tx.addCollateral(obligation, depositCoin, coinName);
    isNewObligation = true;
  }

  // Step 5: Update oracles (critical for Scallop!)
  await tx.updateAssetPricesQuick([coinName, "usdc"]);

  // Step 6: Borrow USDC
  const borrowedUsdc = tx.borrow(
    obligation,
    obligationKey,
    Number(borrowAmount),
    "usdc",
  );

  // Step 7: Repay flash loan
  await tx.repayFlashLoan(borrowedUsdc, receipt, "usdc");

  // Step 8: Finalize
  if (isNewObligation) {
    tx.returnObligation(obligation, obligationHotPotato);
    tx.stakeObligation(obligation, obligationKey);
    tx.transferObjects([obligationKey], userAddress);
  } else {
    tx.stakeObligation(obligation, obligationKey);
  }

  return { tx, builder };
}
