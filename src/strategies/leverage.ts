/**
 * DeFi Dash SDK - Leverage Strategy Builder
 *
 * Builds leverage transactions using flash loan + swap + deposit + borrow
 */

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { MetaAg, getTokenPrice } from '@7kprotocol/sdk-ts';
import { ILendingProtocol, USDC_COIN_TYPE, LeveragePreview } from '../types';
import { ScallopFlashLoanClient } from '../protocols/scallop/flash-loan';
import { normalizeCoinType } from '../utils';
import { getReserveByCoinType } from '../protocols/suilend/constants';

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
 */
// Check ❌
// I'm not sure, but Do we need this logic in the leverage strategy file?
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

  // Check ❌
  // First check the deposit asset coin type and reject USDC deposits
  // we need to make a unsupport_coin_list for this method to reject stable coins like USDC, USDT..
  if (depositCoinType === USDC_COIN_TYPE) {
    throw new Error('Deposit asset cannot be USDC for leverage strategy');
  }

  // Check ❌
  // normalizeCoinType, getReserveByCoinType functios are refered from suilend/constants.ts
  // but that is suilend specific. We need to make sure this works for other protocols as well.
  // option 1: make a sdk level query method to fetch that information in real-time
  // option 2: make a reserve list for each protocol and select based on the protocol param. in this case, we make a constraint for protocol if someone want to support a new protocol this info always come with the protocol adapter.
  // decimal information also should be moved into @types/constants.ts
  const normalized = normalizeCoinType(depositCoinType);
  const reserve = getReserveByCoinType(normalized);
  const decimals = reserve?.decimals || 8;

  // Calculate preview to get flash loan amount
  const preview = await calculateLeveragePreview({
    depositCoinType: normalized,
    depositAmount,
    multiplier,
  });

  // Check ❌
  // TODO: Assueme USDC amount for flash loan depending on deposit value
  const flashLoanUsdc = preview.flashLoanUsdc;

  // 1. Flash loan USDC from Scallop
  const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
    tx,
    flashLoanUsdc,
    'usdc', // Check ❌, TODO: 이거 상수화 시키는게 낫지 않을까? 그리고 따로 sdk 레벨에서 상수 코드에서 관리 후 여기서 참조. leverage asset으로 해서, 추후 usdt 같은 다른 코인도 지원가능하게 해야함.
  );

  // 2. Swap USDC → deposit asset
  let swappedAsset: any;

  // Check ❌
  // NOTE: 이 부분 코드를 삭제 애초에 스테이블 코인은 이 레버리지 허용을 안하는게 맞을 듯
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
      (a, b) => Number(b.amountOut) - Number(a.amountOut),
    )[0];

    swappedAsset = await swapClient.swap(
      {
        quote: bestQuote,
        signer: userAddress,
        coinIn: loanCoin,
        tx: tx,
      },
      // Check ❌
      // We have to set this slippage value configurable from the leverage method param.
      100, // slippage
    );
  }

  // 3. Prepare deposit coin (merge user's asset with swapped)
  let depositCoin: any;
  const isSui = normalized.endsWith('::sui::SUI');

  if (isSui) {
    // For SUI: swappedAsset is already Coin<SUI> from swap
    // Split user's deposit from gas and merge INTO swapped asset
    // Check ❌
    // everytime do we have to do this logic for splitting user's SUI from gas?
    // we have to do test for it. with querying user's SUI balance first.
    // leave this logic at first, but we have to optimize this later. Just take a note at TODO list
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

  // 4. Refresh oracles
  // Check ❌
  // this logic must be here? we have to check again it.
  await protocol.refreshOracles(tx, [normalized, USDC_COIN_TYPE], userAddress);

  // 5. Deposit to lending protocol
  await protocol.deposit(tx, depositCoin, normalized, userAddress);

  // 6. Calculate repayment amount (flash loan + fee + borrow interest buffer)
  // Check ❌
  // 어차파 내부적으로 알아서 계산할텐데 우리가 이걸 여기서 한번 더 할 필요가 있나?
  // 그냥 flashLoanUsdc 값만 넘겨주고 내부에서 계산하게 하는게 맞지 않을까?
  // 차라리 protocol sdk 레벨에서 현재 플래시론을 지원하는 프로토콜의 fee를 쿼리해주는 메소드를 추가하자.
  const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
  const repaymentAmount = flashLoanUsdc + flashLoanFee;

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

  // 8. Repay flash loan
  // Check ❌
  // 궁금한게 만약에 내가 1달러 빌렸다가 1.05 달러로 갚아도 트랜잭션이 성공하나?
  // scripts/scallop/flash_loan_test.ts 에서 테스트 케이스를 한번 만들어보자.
  flashLoanClient.repayFlashLoan(tx, borrowedUsdc, receipt, 'usdc');
}
