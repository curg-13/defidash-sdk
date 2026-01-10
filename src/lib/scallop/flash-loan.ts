import { Transaction } from "@mysten/sui/transactions";
import { SCALLOP_ADDRESSES, getCoinType } from "./scallop-addresses";

// Type for transaction arguments that can be passed around
type TransactionArgument = ReturnType<Transaction["splitCoins"]>;

/**
 * Borrow a flash loan from Scallop
 *
 * @param tx - Sui Transaction object
 * @param amount - Amount to borrow (in smallest unit)
 * @param coinName - Coin name (e.g., 'sui', 'usdc')
 * @returns [loanCoin, receipt] - The borrowed coin and flash loan receipt (Hot Potato)
 */
export function borrowFlashLoan(
  tx: Transaction,
  amount: number | bigint,
  coinName: string
): [TransactionArgument, TransactionArgument] {
  const { protocolPkg, version, market } = SCALLOP_ADDRESSES.core;
  const coinType = getCoinType(coinName);

  const result = tx.moveCall({
    target: `${protocolPkg}::flash_loan::borrow_flash_loan`,
    typeArguments: [coinType],
    arguments: [tx.object(version), tx.object(market), tx.pure.u64(amount)],
  });

  // Returns [Coin<T>, FlashLoan<T>]
  return [result[0] as any, result[1] as any];
}

/**
 * Repay a flash loan to Scallop
 *
 * @param tx - Sui Transaction object
 * @param coin - The coin to repay (must include fee)
 * @param receipt - The flash loan receipt (Hot Potato)
 * @param coinName - Coin name (e.g., 'sui', 'usdc')
 */
export function repayFlashLoan(
  tx: Transaction,
  coin: TransactionArgument,
  receipt: TransactionArgument,
  coinName: string
): void {
  const { protocolPkg, version, market } = SCALLOP_ADDRESSES.core;
  const coinType = getCoinType(coinName);

  tx.moveCall({
    target: `${protocolPkg}::flash_loan::repay_flash_loan`,
    typeArguments: [coinType],
    arguments: [
      tx.object(version),
      tx.object(market),
      coin as any,
      receipt as any,
    ],
  });
}

/**
 * Query flash loan fee for a specific asset
 * Flash loan fee is typically 0.05% (5 basis points)
 *
 * @param amount - Loan amount
 * @returns Expected fee amount
 */
export function calculateFlashLoanFee(amount: bigint): bigint {
  // Default flash loan fee is 0.05% = 5 / 10000
  const FEE_RATE = 5n;
  const FEE_DENOMINATOR = 10000n;
  return (amount * FEE_RATE) / FEE_DENOMINATOR;
}
