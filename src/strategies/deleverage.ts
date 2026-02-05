/**
 * DeFi Dash SDK - Deleverage Strategy Builder
 *
 * Builds deleverage transactions to close leveraged positions
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ILendingProtocol, USDC_COIN_TYPE, PositionInfo } from "../types";
import { ScallopFlashLoanClient } from "../protocols/scallop/flash-loan";

export interface DeleverageBuildParams {
  protocol: ILendingProtocol;
  flashLoanClient: ScallopFlashLoanClient;
  swapClient: MetaAg;
  suiClient: SuiClient;
  userAddress: string;
  position: PositionInfo;
}

export interface DeleverageEstimate {
  flashLoanUsdc: bigint;
  flashLoanFee: bigint;
  totalRepayment: bigint;
  swapAmount: bigint;
  keepCollateral: bigint;
  estimatedUsdcProfit: bigint;
  totalProfitUsd: number;
}

/**
 * Build Scallop-specific deleverage transaction using direct moveCall
 * (matches success script pattern exactly)
 */
async function buildScallopDeleverageTransaction(
  tx: Transaction,
  params: DeleverageBuildParams,
  flashLoanClient: ScallopFlashLoanClient,
  estimate: DeleverageEstimate,
): Promise<void> {
  const { protocol, swapClient, userAddress, position } = params;
  const scallopAdapter = protocol as any;

  const supplyCoinType = position.collateral.coinType;
  const borrowCoinType = USDC_COIN_TYPE;
  const withdrawAmount = position.collateral.amount;

  // Get Scallop addresses
  const scallopAddresses = scallopAdapter.getAddresses();
  const coreAddresses = scallopAddresses.core;
  const borrowIncentiveAddresses = scallopAddresses.borrowIncentive;
  const veScaAddresses = scallopAddresses.vesca;

  // Get obligation info
  const obligations = await scallopAdapter.getObligations(userAddress);
  if (obligations.length === 0) {
    throw new Error("No obligation found for Scallop deleverage");
  }

  const obligationId = obligations[0].id;
  const obligationKeyId = obligations[0].keyId;
  const isLocked = obligations[0].locked;

  // Step 0: Unstake if locked
  if (isLocked) {
    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: "1",
    });

    tx.moveCall({
      target: `${borrowIncentiveAddresses.pkg}::user::unstake_v2`,
      arguments: [
        tx.object(borrowIncentiveAddresses.config),
        tx.object(borrowIncentiveAddresses.incentivePools),
        tx.object(borrowIncentiveAddresses.incentiveAccounts),
        tx.object(obligationKeyId),
        tx.object(obligationId),
        tx.object(veScaAddresses.subsTable),
        tx.object(veScaAddresses.subsWhitelist),
        clockRef,
      ],
    });
  }

  // Step 1: Flash loan USDC
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
    tx,
    estimate.flashLoanUsdc,
    "usdc",
  );

  // Step 2: Repay debt (direct moveCall)
  const clockRef = tx.sharedObjectRef({
    objectId: SUI_CLOCK_OBJECT_ID,
    mutable: false,
    initialSharedVersion: "1",
  });

  tx.moveCall({
    target: `${coreAddresses.protocolPkg}::repay::repay`,
    typeArguments: [borrowCoinType],
    arguments: [
      tx.object(coreAddresses.version),
      tx.object(obligationId),
      tx.object(coreAddresses.market),
      loanCoin as any,
      clockRef,
    ],
  });

  // Step 3: Withdraw collateral (direct moveCall)
  const clockRef2 = tx.sharedObjectRef({
    objectId: SUI_CLOCK_OBJECT_ID,
    mutable: false,
    initialSharedVersion: "1",
  });

  const [withdrawnCoin] = tx.moveCall({
    target: `${coreAddresses.protocolPkg}::withdraw_collateral::withdraw_collateral`,
    typeArguments: [supplyCoinType],
    arguments: [
      tx.object(coreAddresses.version),
      tx.object(obligationId),
      tx.object(obligationKeyId),
      tx.object(coreAddresses.market),
      tx.object(coreAddresses.coinDecimalsRegistry),
      tx.pure.u64(withdrawAmount),
      tx.object(coreAddresses.xOracle),
      clockRef2,
    ],
  });

  // Step 4: Get swap quote and swap
  const swapQuotes = await swapClient.quote({
    amountIn: estimate.swapAmount.toString(),
    coinTypeIn: supplyCoinType,
    coinTypeOut: USDC_COIN_TYPE,
  });

  if (swapQuotes.length === 0) {
    throw new Error(`No swap quotes for ${position.collateral.symbol} → USDC`);
  }

  const bestQuote = swapQuotes.sort(
    (a, b) => Number(b.amountOut) - Number(a.amountOut),
  )[0];

  // Split coin for swap
  const [coinToSwap] = tx.splitCoins(withdrawnCoin, [estimate.swapAmount]);

  const swappedUsdc = await swapClient.swap(
    {
      quote: bestQuote,
      signer: userAddress,
      coinIn: coinToSwap,
      tx: tx,
    },
    100,
  );

  // Step 5: Repay flash loan
  const [flashRepayment] = tx.splitCoins(swappedUsdc as any, [
    estimate.totalRepayment,
  ]);
  flashLoanClient.repayFlashLoan(tx, flashRepayment as any, receipt, "usdc");

  // Step 6: Transfer remaining to user
  tx.transferObjects([withdrawnCoin as any, swappedUsdc as any], userAddress);
}

/**
 * Calculate deleverage estimates
 */
export async function calculateDeleverageEstimate(
  params: DeleverageBuildParams,
): Promise<DeleverageEstimate> {
  const { swapClient, position } = params;

  const borrowAmount = position.debt.amount;
  const supplyAmount = position.collateral.amount;
  const supplyCoinType = position.collateral.coinType;
  const supplyDecimals = position.collateral.decimals;

  // Flash loan with small buffer (0.1%) to cover interest that accrues during tx
  // Interest accrues immediately on borrowed USDC, so we need slightly more to fully repay
  const flashLoanUsdc = (borrowAmount * 1001n) / 1000n;
  const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
  const totalRepayment = flashLoanUsdc + flashLoanFee;

  // Get swap rate - use full collateral amount
  const withdrawAmount = supplyAmount; // Withdraw ALL collateral
  const fullSwapQuotes = await swapClient.quote({
    amountIn: withdrawAmount.toString(),
    coinTypeIn: supplyCoinType,
    coinTypeOut: USDC_COIN_TYPE,
  });

  if (fullSwapQuotes.length === 0) {
    throw new Error(
      `No swap quotes found for ${position.collateral.symbol} → USDC`,
    );
  }

  const fullQuote = fullSwapQuotes.sort(
    (a, b) => Number(b.amountOut) - Number(a.amountOut),
  )[0];

  const fullSwapOut = BigInt(fullQuote.amountOut);
  const fullSwapIn = BigInt(fullQuote.amountIn);

  // Calculate optimal swap amount (with 2% buffer)
  const targetUsdcOut = (totalRepayment * 102n) / 100n;
  const requiredSwapIn = (targetUsdcOut * fullSwapIn) / fullSwapOut;
  const actualSwapIn =
    requiredSwapIn > withdrawAmount ? withdrawAmount : requiredSwapIn;

  const keepCollateral = withdrawAmount - actualSwapIn;
  const estimatedUsdcProfit =
    fullSwapOut > totalRepayment
      ? (actualSwapIn * fullSwapOut) / fullSwapIn - totalRepayment
      : 0n;

  const supplyPrice = await getTokenPrice(supplyCoinType);
  const totalProfitUsd =
    (Number(keepCollateral) / Math.pow(10, supplyDecimals)) * supplyPrice +
    Number(estimatedUsdcProfit) / 1e6;

  return {
    flashLoanUsdc,
    flashLoanFee,
    totalRepayment,
    swapAmount: actualSwapIn,
    keepCollateral,
    estimatedUsdcProfit,
    totalProfitUsd,
  };
}

/**
 * Build deleverage transaction
 *
 * Flow:
 * 0. (Scallop only) Unstake obligation if locked
 * 1. Flash loan USDC (to repay debt)
 * 2. Refresh oracles
 * 3. Repay debt using flash loan
 * 4. Withdraw all collateral
 * 5. Swap partial collateral → USDC
 * 6. Repay flash loan
 * 7. Transfer remaining to user
 */
export async function buildDeleverageTransaction(
  tx: Transaction,
  params: DeleverageBuildParams,
): Promise<void> {
  const {
    protocol,
    flashLoanClient,
    swapClient,
    suiClient,
    userAddress,
    position,
  } = params;

  const supplyCoinType = position.collateral.coinType;
  const supplyAmount = position.collateral.amount;

  // Calculate estimates
  const estimate = await calculateDeleverageEstimate(params);

  // Scallop uses direct moveCall (like success script), other protocols use adapter
  if (protocol.name === "scallop") {
    // Scallop-specific implementation (matches success script pattern)
    await buildScallopDeleverageTransaction(
      tx,
      params,
      flashLoanClient,
      estimate,
    );
    return;
  }

  // Generic implementation for other protocols (Suilend, Navi)
  // 1. Flash loan USDC
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
    tx,
    estimate.flashLoanUsdc,
    "usdc",
  );

  // 2. Refresh oracles
  await protocol.refreshOracles(
    tx,
    [supplyCoinType, USDC_COIN_TYPE],
    userAddress,
  );

  // 3. Repay debt using flash loan
  await protocol.repay(tx, USDC_COIN_TYPE, loanCoin, userAddress);

  // 4. Withdraw ALL collateral
  const withdrawAmount = supplyAmount;
  const withdrawnCoin = await protocol.withdraw(
    tx,
    supplyCoinType,
    withdrawAmount.toString(),
    userAddress,
  );

  // 5. Get swap quote and swap
  const swapQuotes = await swapClient.quote({
    amountIn: estimate.swapAmount.toString(),
    coinTypeIn: supplyCoinType,
    coinTypeOut: USDC_COIN_TYPE,
  });

  if (swapQuotes.length === 0) {
    throw new Error(`No swap quotes for ${position.collateral.symbol} → USDC`);
  }

  const bestQuote = swapQuotes.sort(
    (a, b) => Number(b.amountOut) - Number(a.amountOut),
  )[0];

  // Split coin for swap
  const [coinToSwap] = tx.splitCoins(withdrawnCoin, [estimate.swapAmount]);

  const swappedUsdc = await swapClient.swap(
    {
      quote: bestQuote,
      signer: userAddress,
      coinIn: coinToSwap,
      tx: tx,
    },
    100,
  );

  // 6. Repay flash loan
  const [flashRepayment] = tx.splitCoins(swappedUsdc as any, [
    estimate.totalRepayment,
  ]);
  flashLoanClient.repayFlashLoan(tx, flashRepayment as any, receipt, "usdc");

  // 7. Transfer remaining to user
  // Some protocols consume the repayment coin entirely, others return unused portion
  if (protocol.consumesRepaymentCoin) {
    // Protocol consumed loanCoin in repay(), don't transfer it
    tx.transferObjects([withdrawnCoin as any, swappedUsdc as any], userAddress);
  } else {
    // Protocol left remaining balance in loanCoin, transfer it
    tx.transferObjects(
      [withdrawnCoin as any, swappedUsdc as any, loanCoin as any],
      userAddress,
    );
  }
}
