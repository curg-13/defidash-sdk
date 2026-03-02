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
  UNSUPPORTED_COIN_TYPES,
} from "../types";
import { ScallopFlashLoanClient } from "../protocols/scallop/flash-loan";
import { normalizeCoinType, getDecimals } from "../utils";
import { findBestSwapQuote, BORROW_FEE_BUFFER } from "./common";

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
 * Build leverage transaction as a Programmable Transaction Block (PTB)
 *
 * Constructs an atomic transaction that executes the full leverage strategy.
 *
 * **Transaction Flow:**
 * 1. Borrow USDC via flash loan from Scallop
 * 2. Refresh protocol oracles (before swap to avoid Pyth conflicts)
 * 3. Swap USDC to deposit asset via 7k Protocol aggregator
 * 4. Merge user's deposit with swapped amount
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
    // TODO(#6): Use typed UnsupportedAssetError instead of generic Error
    throw new Error(
      `Unsupported deposit asset for leverage strategy. Stablecoins like USDC cannot be used as collateral.`,
    );
  }

  const normalized = normalizedDeposit;
  const decimals = getDecimals(normalized);

  // Calculate flash loan amount directly
  const depositPrice = await getTokenPrice(normalized);
  const initialEquityUsd = (Number(depositAmount) / 10 ** decimals) * depositPrice;
  const flashLoanUsdc = BigInt(Math.ceil(initialEquityUsd * (multiplier - 1) * 1e6));

  // 1. Flash loan USDC from Scallop
  // TODO(#7): Support other flash loan assets (USDT) in the future
  const FLASH_LOAN_ASSET = "usdc" as const;
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
    tx,
    flashLoanUsdc,
    FLASH_LOAN_ASSET,
  );

  // 2. Refresh oracles BEFORE swap to avoid Pyth hot potato conflicts.
  // The 7k swap may add Pyth oracle update commands for DEX routing.
  // If refreshOracles also adds Pyth updates for the same feeds AFTER
  // the swap, both create Pyth hot potatoes for the same price feeds,
  // causing dynamic_field::add abort. Refreshing first ensures the
  // protocol's Pyth lifecycle completes before the swap starts.
  await protocol.refreshOracles(tx, [normalized, USDC_COIN_TYPE], userAddress);

  // 3. Swap USDC → deposit asset
  // Note: Stablecoins are already rejected above, so swap is always needed
  const { quote: bestQuote } = await findBestSwapQuote(
    swapClient,
    flashLoanUsdc.toString(),
    USDC_COIN_TYPE,
    normalized,
    `USDC \u2192 ${normalized.split("::").pop() ?? normalized}`,
  );

  // TODO(#8): Make slippage configurable via leverage params
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

  // 4. Prepare deposit coin (merge user's asset with swapped)
  let depositCoin: any;
  const isSui = normalized.endsWith("::sui::SUI");

  if (isSui) {
    // For SUI: swappedAsset is already Coin<SUI> from swap
    // Split user's deposit from gas and merge INTO swapped asset
    // TODO(#9): Optimize SUI handling - consider checking balance first
    const [userDeposit] = tx.splitCoins(tx.gas, [tx.pure.u64(depositAmount)]);
    tx.mergeCoins(swappedAsset, [userDeposit]);
    depositCoin = swappedAsset;
  } else {
    // For non-SUI: fetch ALL user's coins (paginated), merge, split exact amount
    const allCoins: Array<{ coinObjectId: string; balance: string }> = [];
    let cursor: string | null | undefined = undefined;
    do {
      const page = await suiClient.getCoins({
        owner: userAddress,
        coinType: normalized,
        cursor: cursor ?? undefined,
      });
      allCoins.push(...page.data);
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);

    if (allCoins.length === 0) {
      throw new Error(`No ${normalized.split("::").pop()} coins found in wallet`);
    }

    const primaryCoin = tx.object(allCoins[0].coinObjectId);
    if (allCoins.length > 1) {
      const otherCoins = allCoins
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

  // 5. Deposit to lending protocol
  await protocol.deposit(tx, depositCoin, normalized, userAddress);

  // 6. Calculate repayment amount (flash loan + fee + borrow interest buffer)
  // TODO(#10): Consider adding flash loan fee query method to protocol SDK
  // const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
  const repaymentAmount = flashLoanUsdc;

  // Add buffer for borrow interest that accrues immediately
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
