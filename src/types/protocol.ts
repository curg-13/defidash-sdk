/**
 * Protocol interface and related types
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { PositionInfo, AccountPortfolio } from "./position";

/**
 * Market reserve information
 */
export interface MarketReserve {
  coinType: string;
  id: string;
  decimals: number;
  symbol: string;
}

/**
 * Common interface for all lending protocol adapters
 */
export interface ILendingProtocol {
  /** Protocol name identifier */
  readonly name: string;

  /**
   * Whether the protocol's repay function consumes the entire coin
   * - true: repay() consumes the coin entirely (e.g., Navi)
   * - false: repay() returns unused portion in the coin (e.g., Suilend)
   */
  readonly consumesRepaymentCoin: boolean;

  /**
   * Initialize the protocol client
   * Must be called before using other methods
   */
  initialize(suiClient: SuiClient): Promise<void>;

  /**
   * Get current lending position for a user
   * @param userAddress - Sui address of the user
   * @returns Position info or null if no position exists
   */
  getPosition(userAddress: string): Promise<PositionInfo | null>;

  /**
   * Deposit collateral into the lending protocol
   * @param tx - Transaction to add deposit command to
   * @param coin - Coin object to deposit
   * @param coinType - Full coin type string
   * @param userAddress - User's address (for obligation lookup)
   */
  deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void>;

  /**
   * Withdraw collateral from the lending protocol
   * @param tx - Transaction to add withdraw command to
   * @param coinType - Full coin type string
   * @param amount - Amount to withdraw (raw units as string)
   * @param userAddress - User's address
   * @returns Withdrawn coin object
   */
  withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any>;

  /**
   * Borrow from the lending protocol
   * @param tx - Transaction to add borrow command to
   * @param coinType - Full coin type string (e.g., USDC)
   * @param amount - Amount to borrow (raw units as string)
   * @param userAddress - User's address
   * @param skipOracle - Skip oracle refresh (if already done)
   * @returns Borrowed coin object
   */
  borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
    skipOracle?: boolean,
  ): Promise<any>;

  /**
   * Repay debt to the lending protocol
   * @param tx - Transaction to add repay command to
   * @param coinType - Full coin type string
   * @param coin - Coin object to use for repayment
   * @param userAddress - User's address
   */
  repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void>;

  /**
   * Refresh oracle prices (protocol-specific)
   * Must be called before deposit/borrow operations
   * @param tx - Transaction to add refresh commands to
   * @param coinTypes - Coin types to refresh oracles for
   * @param userAddress - User's address (for obligation lookup)
   */
  refreshOracles(
    tx: Transaction,
    coinTypes: string[],
    userAddress: string,
  ): Promise<void>;

  /**
   * Fetch aggregated account portfolio
   * @param address - User address
   */
  getAccountPortfolio(address: string): Promise<AccountPortfolio>;
}
