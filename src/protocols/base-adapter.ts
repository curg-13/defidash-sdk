/**
 * Base Protocol Adapter
 *
 * Abstract base class providing common functionality for all protocol adapters.
 * Reduces code duplication and ensures consistent implementation patterns.
 */

import { SuiClient } from "@mysten/sui/client";
import { ILendingProtocol } from "../types";
import { normalizeCoinType } from "../utils";

/**
 * Abstract base class for protocol adapters
 *
 * Provides common functionality that all protocol adapters need:
 * - SuiClient management
 * - Coin type normalization
 * - Initialization tracking
 *
 * @example
 * ```typescript
 * class MyProtocolAdapter extends BaseProtocolAdapter {
 *   readonly name = "MyProtocol";
 *   readonly consumesRepaymentCoin = false;
 *
 *   async initialize(client: SuiClient): Promise<void> {
 *     await super.initialize(client);
 *     // Protocol-specific initialization
 *   }
 *
 *   async getPosition(address: string): Promise<PositionInfo | null> {
 *     this.ensureInitialized();
 *     // Implementation
 *   }
 * }
 * ```
 */
export abstract class BaseProtocolAdapter implements Partial<ILendingProtocol> {
  /**
   * Sui client instance
   * Available after initialization
   */
  protected suiClient!: SuiClient;

  /**
   * Initialization status
   */
  protected initialized = false;

  /**
   * Protocol name (must be implemented by subclass)
   */
  abstract readonly name: string;

  /**
   * Whether protocol consumes repayment coin entirely
   * (must be implemented by subclass)
   */
  abstract readonly consumesRepaymentCoin: boolean;

  /**
   * Initialize the protocol adapter
   *
   * @param suiClient - Sui blockchain client
   */
  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;
    this.initialized = true;
  }

  /**
   * Ensure adapter is initialized before use
   *
   * @throws Error if not initialized
   */
  protected ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`${this.name} adapter not initialized`);
    }
  }

  /**
   * Normalize coin type to standard format
   *
   * Utility method for consistent coin type handling.
   *
   * @param coinType - Raw coin type string
   * @returns Normalized coin type with padded address
   *
   * @example
   * ```typescript
   * const normalized = this.normalizeCoin("0x2::sui::SUI");
   * // "0x0000...0002::sui::SUI"
   * ```
   */
  protected normalizeCoin(coinType: string): string {
    return normalizeCoinType(coinType);
  }

  /**
   * Get object by ID with error handling
   *
   * @param objectId - Object ID to fetch
   * @returns Object data or null if not found
   */
  protected async getObject(objectId: string): Promise<any> {
    try {
      const response = await this.suiClient.getObject({
        id: objectId,
        options: {
          showContent: true,
          showType: true,
        },
      });
      return response.data;
    } catch (error) {
      console.error(`Failed to fetch object ${objectId}:`, error);
      return null;
    }
  }

  /**
   * Format amount from raw units to human-readable
   *
   * @param amount - Raw amount (bigint)
   * @param decimals - Token decimals
   * @returns Human-readable number
   */
  protected formatAmount(amount: bigint, decimals: number): number {
    return Number(amount) / Math.pow(10, decimals);
  }

  /**
   * Parse amount from human-readable to raw units
   *
   * @param amount - Human-readable amount (number or string)
   * @param decimals - Token decimals
   * @returns Raw amount as bigint
   */
  protected parseAmount(amount: number | string, decimals: number): bigint {
    const value = typeof amount === "string" ? parseFloat(amount) : amount;
    return BigInt(Math.floor(value * Math.pow(10, decimals)));
  }
}
