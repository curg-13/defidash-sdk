/**
 * DeFi Dash SDK - Leverage Strategy Builder
 *
 * Builds leverage transactions using flash loan + swap + deposit + borrow
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ILendingProtocol } from "../protocols/interface";
import { ScallopFlashLoanClient } from "../lib/scallop";
import { normalizeCoinType, formatUnits, parseUnits } from "../lib/utils";
import { getReserveByCoinType } from "../lib/suilend/const";
import { USDC_COIN_TYPE, SUI_COIN_TYPE, LeveragePreview } from "../types";

export interface LeverageBuildParams {
  protocol: ILendingProtocol;
  flashLoanClient: ScallopFlashLoanClient;
  swapClient: MetaAg;
  suiClient: SuiClient;
  userAddress: string;
  depositCoinType: string;
  depositAmount: bigint;
  multiplier: number;
}

/**
 * Calculate leverage position preview (before execution)
 */
export async function calculateLeveragePreview(params: {
  depositCoinType: string;
  depositAmount: bigint;
  multiplier: number;
}): Promise<LeveragePreview> {
  const { depositCoinType, depositAmount, multiplier } = params;

  const normalized = normalizeCoinType(depositCoinType);
  const reserve = getReserveByCoinType(normalized);
  const decimals = reserve?.decimals || 8;

  const depositPrice = await getTokenPrice(normalized);
  const depositAmountHuman = Number(depositAmount) / Math.pow(10, decimals);
  const initialEquityUsd = depositAmountHuman * depositPrice;

  // Flash loan amount = Initial Equity * (Multiplier - 1)
  const flashLoanUsd = initialEquityUsd * (multiplier - 1);
  const flashLoanUsdc = BigInt(Math.ceil(flashLoanUsd * 1e6 * 1.02)); // 2% buffer

  const totalPositionUsd = initialEquityUsd * multiplier;
  const debtUsd = flashLoanUsd;
  const ltvPercent = (debtUsd / totalPositionUsd) * 100;

  // Assume 60% LTV for liquidation calculation
  const LTV = 0.6;
  const liquidationPrice = debtUsd / (depositAmountHuman * multiplier) / LTV;
  const priceDropBuffer = (1 - liquidationPrice / depositPrice) * 100;

  return {
    initialEquityUsd,
    flashLoanUsdc,
    totalPositionUsd,
    debtUsd,
    effectiveMultiplier: multiplier,
    ltvPercent,
    liquidationPrice,
    priceDropBuffer,
  };
}

/**
 * Build leverage transaction
 *
 * Flow:
 * 1. Flash loan USDC from Scallop
 * 2. Swap USDC → deposit asset
 * 3. Merge user's deposit with swapped asset
 * 4. Refresh oracles
 * 5. Deposit total to lending protocol
 * 6. Borrow USDC to repay flash loan
 * 7. Repay flash loan
 */
export async function buildLeverageTransaction(
  tx: Transaction,
  params: LeverageBuildParams
): Promise<void> {
  const {
    protocol,
    flashLoanClient,
    swapClient,
    suiClient,
    userAddress,
    depositCoinType,
    depositAmount,
    multiplier,
  } = params;

  const normalized = normalizeCoinType(depositCoinType);
  const reserve = getReserveByCoinType(normalized);
  const decimals = reserve?.decimals || 8;

  // Calculate preview to get flash loan amount
  const preview = await calculateLeveragePreview({
    depositCoinType: normalized,
    depositAmount,
    multiplier,
  });

  const flashLoanUsdc = preview.flashLoanUsdc;

  // 1. Flash loan USDC from Scallop
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
    tx,
    flashLoanUsdc,
    "usdc"
  );

  // 2. Swap USDC → deposit asset
  let swappedAsset: any;

  if (normalized === USDC_COIN_TYPE) {
    // No swap needed
    swappedAsset = loanCoin;
  } else {
    const swapQuotes = await swapClient.quote({
      amountIn: flashLoanUsdc.toString(),
      coinTypeIn: USDC_COIN_TYPE,
      coinTypeOut: normalized,
    });

    if (swapQuotes.length === 0) {
      throw new Error(`No swap quotes found for USDC → ${reserve?.symbol}`);
    }

    const bestQuote = swapQuotes.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut)
    )[0];

    swappedAsset = await swapClient.swap(
      {
        quote: bestQuote,
        signer: userAddress,
        coinIn: loanCoin,
        tx: tx,
      },
      100 // slippage
    );
  }

  // 3. Prepare deposit coin (merge user's asset with swapped)
  let depositCoin: any;
  const isSui = normalized.endsWith("::sui::SUI");

  if (isSui) {
    // For SUI: split from gas and merge
    const [userDeposit] = tx.splitCoins(tx.gas, [depositAmount]);
    tx.mergeCoins(userDeposit, [swappedAsset]);
    depositCoin = userDeposit;
  } else {
    // For non-SUI: fetch user's coins, merge, split exact amount
    const userCoins = await suiClient.getCoins({
      owner: userAddress,
      coinType: normalized,
    });

    if (userCoins.data.length === 0) {
      throw new Error(`No ${reserve?.symbol} coins found in wallet`);
    }

    const primaryCoin = tx.object(userCoins.data[0].coinObjectId);
    if (userCoins.data.length > 1) {
      const otherCoins = userCoins.data
        .slice(1)
        .map((c) => tx.object(c.coinObjectId));
      tx.mergeCoins(primaryCoin, otherCoins);
    }

    // Split exact deposit amount
    const [userContribution] = tx.splitCoins(primaryCoin, [depositAmount]);
    tx.mergeCoins(userContribution, [swappedAsset]);
    depositCoin = userContribution;
  }

  // 4. Refresh oracles
  await protocol.refreshOracles(tx, [normalized, USDC_COIN_TYPE], userAddress);

  // 5. Deposit to lending protocol
  await protocol.deposit(tx, depositCoin, normalized, userAddress);

  // 6. Calculate repayment amount (flash loan + fee)
  const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
  const repaymentAmount = flashLoanUsdc + flashLoanFee;

  // 7. Borrow USDC to repay flash loan
  const borrowedUsdc = await protocol.borrow(
    tx,
    USDC_COIN_TYPE,
    repaymentAmount.toString(),
    userAddress,
    true // Skip oracle (already done)
  );

  // 8. Repay flash loan
  flashLoanClient.repayFlashLoan(tx, borrowedUsdc, receipt, "usdc");
}
