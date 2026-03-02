/**
 * Base Protocol Adapter
 *
 * Abstract base class for all lending protocol adapters.
 * Implements ILendingProtocol to enforce compile-time method checks.
 *
 * Any class extending this MUST implement all abstract methods,
 * otherwise TypeScript will produce a build error:
 *   "Non-abstract class 'XxxAdapter' does not implement inherited abstract member 'methodName'"
 *
 * This is the TypeScript equivalent of Go's interface compliance pattern:
 *   var _ ILendingProtocol = (*MyAdapter)(nil)
 */

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import {
  ILendingProtocol,
  PositionInfo,
  AssetRiskParams,
  AssetApy,
  AccountPortfolio,
} from "../types";
import { normalizeCoinType } from "../utils";

/**
 * Abstract base class for protocol adapters.
 *
 * Provides common utilities (SuiClient management, coin normalization).
 * All ILendingProtocol methods are declared abstract — subclasses MUST implement them.
 *
 * @example
 * ```typescript
 * export class NewProtocolAdapter extends BaseProtocolAdapter {
 *   readonly name = "new-protocol";
 *   readonly consumesRepaymentCoin = false;
 *
 *   async initialize(suiClient: SuiClient): Promise<void> {
 *     await super.initialize(suiClient);
 *     // protocol-specific init
 *   }
 *
 *   // All abstract methods must be implemented:
 *   async getPosition(userAddress: string) { ... }
 *   async deposit(tx, coin, coinType, userAddress) { ... }
 *   async withdraw(tx, coinType, amount, userAddress) { ... }
 *   async borrow(tx, coinType, amount, userAddress) { ... }
 *   async repay(tx, coinType, coin, userAddress) { ... }
 *   async refreshOracles(tx, coinTypes, userAddress) { ... }
 *   async getAccountPortfolio(address) { ... }
 *   async getAssetRiskParams(coinType) { ... }
 *   async getAssetApy(coinType) { ... }
 * }
 * ```
 */
export abstract class BaseProtocolAdapter implements ILendingProtocol {
  protected suiClient!: SuiClient;
  protected initialized = false;

  // ── Required properties (must be set by subclass) ────────────────────────

  abstract readonly name: string;
  abstract readonly consumesRepaymentCoin: boolean;

  // ── Required methods (must be implemented by subclass) ───────────────────

  abstract getPosition(userAddress: string): Promise<PositionInfo | null>;

  abstract deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void>;

  abstract withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any>;

  abstract borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
    skipOracle?: boolean,
  ): Promise<any>;

  abstract repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void>;

  abstract refreshOracles(
    tx: Transaction,
    coinTypes: string[],
    userAddress: string,
  ): Promise<void>;

  abstract getAccountPortfolio(address: string): Promise<AccountPortfolio>;

  abstract getAssetRiskParams(coinType: string): Promise<AssetRiskParams>;

  abstract getAssetApy(coinType: string): Promise<AssetApy>;

  // ── Base implementation ──────────────────────────────────────────────────

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;
    this.initialized = true;
  }

  /**
   * Optional: clear pending state between transactions.
   * Override in subclass if needed (e.g., Scallop obligation tracking).
   */
  clearPendingState(): void {
    // no-op by default
  }

  // ── Protected utilities ──────────────────────────────────────────────────

  protected ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`${this.name} adapter not initialized`);
    }
  }

  protected normalizeCoin(coinType: string): string {
    return normalizeCoinType(coinType);
  }

  protected formatAmount(amount: bigint, decimals: number): number {
    return Number(amount) / Math.pow(10, decimals);
  }

  protected parseAmount(amount: number | string, decimals: number): bigint {
    const value = typeof amount === "string" ? parseFloat(amount) : amount;
    return BigInt(Math.floor(value * Math.pow(10, decimals)));
  }
}
