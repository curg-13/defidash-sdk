/**
 * DeFi Dash SDK - Leverage Strategy Builder
 *
 * Builds leverage transactions using flash loan + swap + deposit + borrow
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import {
  ILendingProtocol,
  USDC_COIN_TYPE,
  LeveragePreview,
  UNSUPPORTED_COIN_TYPES,
  COIN_DECIMALS,
} from "../types";
import { ScallopFlashLoanClient } from "../protocols/scallop/flash-loan";
import { normalizeCoinType } from "../utils";
import { getReserveByCoinType } from "../protocols/suilend/constants";

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
 * Calculate leverage position preview without executing
 *
 * Computes expected position metrics including flash loan amount,
 * total position value, LTV, and liquidation parameters.
 *
 * @param params - Preview calculation parameters
 * @param params.depositCoinType - Full coin type of deposit asset
 * @param params.depositAmount - Deposit amount in raw units (bigint)
 * @param params.multiplier - Target leverage multiplier (e.g., 2.0 for 2x)
 *
 * @returns Preview containing position metrics and risk parameters
 *
 * @example
 * ```typescript
 * const preview = await calculateLeveragePreview({
 *   depositCoinType: '0x2::sui::SUI',
 *   depositAmount: 1000000000n,  // 1 SUI
 *   multiplier: 2.0
 * });
 *
 * console.log(`Flash loan needed: ${preview.flashLoanUsdc / 1e6} USDC`);
 * console.log(`Total position: $${preview.totalPositionUsd}`);
 * console.log(`LTV: ${preview.ltvPercent}%`);
 * ```
 *
 * @remarks
 * - Fetches current market prices from 7k Protocol
 * - Assumes 60% LTV threshold for liquidation calculations
 * - Adds 2% buffer to flash loan amount for safety
 *
 * @note This function is intentionally placed here as it's tightly coupled
 * with the leverage strategy logic. Consider moving to a separate preview
 * module if reuse across strategies is needed.
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
 * Build leverage transaction as a Programmable Transaction Block (PTB)
 *
 * Constructs an atomic transaction that executes the full leverage strategy.
 *
 * **Transaction Flow:**
 * 1. Borrow USDC via flash loan from Scallop
 * 2. Swap USDC to deposit asset via 7k Protocol aggregator
 * 3. Merge user's deposit with swapped amount
 * 4. Refresh protocol oracles
 * 5. Deposit total collateral to lending protocol
 * 6. Borrow USDC from protocol to repay flash loan
 * 7. Repay flash loan (transaction fails if not repaid)
 *
 * @param tx - Sui Transaction object to add commands to
 * @param params - Leverage build parameters
 * @param params.protocol - Protocol adapter (Suilend, Scallop, or Navi)
 * @param params.flashLoanClient - Scallop flash loan client instance
 * @param params.swapClient - 7k Protocol swap aggregator
 * @param params.suiClient - Sui blockchain client
 * @param params.userAddress - User's Sui address
 * @param params.depositCoinType - Full coin type of deposit asset
 * @param params.depositAmount - User's deposit amount (raw units)
 * @param params.multiplier - Target leverage multiplier
 *
 * @returns Promise that resolves when transaction is built (does not execute)
 *
 * @example
 * ```typescript
 * const tx = new Transaction();
 * tx.setSender(userAddress);
 *
 * await buildLeverageTransaction(tx, {
 *   protocol: suilendAdapter,
 *   flashLoanClient,
 *   swapClient,
 *   suiClient,
 *   userAddress,
 *   depositCoinType: '0x2::sui::SUI',
 *   depositAmount: 1000000000n,
 *   multiplier: 2.0
 * });
 *
 * // Execute
 * const result = await client.signAndExecuteTransaction({
 *   signer: keypair,
 *   transaction: tx
 * });
 * ```
 *
 * @remarks
 * - All operations are atomic - transaction fails completely if any step fails
 * - Flash loan MUST be repaid in same transaction or entire tx reverts
 * - Slippage protection applied to swap (1% tolerance)
 */
export async function buildLeverageTransaction(
  tx: Transaction,
  params: LeverageBuildParams,
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

  // Reject unsupported coin types (stablecoins like USDC, wUSDC)
  // These cannot be used as collateral because we borrow USDC to repay the flash loan
  const normalizedDeposit = normalizeCoinType(depositCoinType);
  if (UNSUPPORTED_COIN_TYPES.includes(normalizedDeposit)) {
    // Check ❌: What about listing errors like solidity contract styles to avoid gerneral error message or using enum for erros.
    throw new Error(
      `Unsupported deposit asset for leverage strategy. Stablecoins like USDC cannot be used as collateral.`,
    );
  }

  // Use SDK-level COIN_DECIMALS for decimal info, fallback to reserve lookup
  // TODO: Future improvement - make protocol adapters provide decimal info
  const normalized = normalizedDeposit;
  const reserve = getReserveByCoinType(normalized);
  const decimals = COIN_DECIMALS[normalized] ?? reserve?.decimals ?? 8;

  // Calculate preview to get flash loan amount
  const preview = await calculateLeveragePreview({
    depositCoinType: normalized,
    depositAmount,
    multiplier,
  });

  const flashLoanUsdc = preview.flashLoanUsdc;

  // 1. Flash loan USDC from Scallop
  // TODO: Support other flash loan assets (USDT) in the future
  const FLASH_LOAN_ASSET = "usdc" as const;
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
    tx,
    flashLoanUsdc,
    FLASH_LOAN_ASSET,
  );

  // 2. Swap USDC → deposit asset
  // Note: Stablecoins are already rejected above, so swap is always needed
  const swapQuotes = await swapClient.quote({
    amountIn: flashLoanUsdc.toString(),
    coinTypeIn: USDC_COIN_TYPE,
    coinTypeOut: normalized,
  });

  if (swapQuotes.length === 0) {
    throw new Error(
      `No swap quotes found for USDC → ${reserve?.symbol ?? normalized}`,
    );
  }

  const bestQuote = swapQuotes.sort(
    (a, b) => Number(b.amountOut) - Number(a.amountOut),
  )[0];

  // TODO: Make slippage configurable via leverage params
  const SLIPPAGE_BPS = 100; // 1%
  const swappedAsset = await swapClient.swap(
    {
      quote: bestQuote,
      signer: userAddress,
      coinIn: loanCoin,
      tx: tx,
    },
    SLIPPAGE_BPS,
  );

  // 3. Prepare deposit coin (merge user's asset with swapped)
  let depositCoin: any;
  const isSui = normalized.endsWith("::sui::SUI");

  if (isSui) {
    // For SUI: swappedAsset is already Coin<SUI> from swap
    // Split user's deposit from gas and merge INTO swapped asset
    // TODO: Optimize SUI handling - consider checking balance first
    const [userDeposit] = tx.splitCoins(tx.gas, [tx.pure.u64(depositAmount)]);
    tx.mergeCoins(swappedAsset, [userDeposit]);
    depositCoin = swappedAsset;
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

    // Split exact deposit amount and merge with swapped
    const [userContribution] = tx.splitCoins(primaryCoin, [
      tx.pure.u64(depositAmount),
    ]);
    tx.mergeCoins(swappedAsset, [userContribution]);
    depositCoin = swappedAsset;
  }

  // 4. Refresh oracles (required before deposit/borrow operations)
  await protocol.refreshOracles(tx, [normalized, USDC_COIN_TYPE], userAddress);

  // 5. Deposit to lending protocol
  await protocol.deposit(tx, depositCoin, normalized, userAddress);

  // 6. Calculate repayment amount (flash loan + fee + borrow interest buffer)
  // TODO: Consider adding flash loan fee query method to protocol SDK
  // const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
  const repaymentAmount = flashLoanUsdc;

  // Add 0.5% buffer for borrow interest that accrues immediately
  // This ensures we borrow enough to cover the flash loan repayment
  const BORROW_FEE_BUFFER = 1.005;
  const borrowAmount = BigInt(
    Math.ceil(Number(repaymentAmount) * BORROW_FEE_BUFFER),
  );

  // 7. Borrow USDC to repay flash loan
  const borrowedUsdc = await protocol.borrow(
    tx,
    USDC_COIN_TYPE,
    borrowAmount.toString(),
    userAddress,
    true, // Skip oracle (already done)
  );

  // 8. Repay flash loan (excess amount is returned to user)
  flashLoanClient.repayFlashLoan(tx, borrowedUsdc, receipt, FLASH_LOAN_ASSET);
}
