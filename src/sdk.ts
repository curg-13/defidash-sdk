/**
 * DeFi Dash SDK - Main SDK Class
 *
 * Multi-protocol DeFi SDK for Sui blockchain
 */

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";

import {
  LendingProtocol,
  LeverageParams,
  DeleverageParams,
  PositionInfo,
  StrategyResult,
  LeveragePreview,
  SDKOptions,
  USDC_COIN_TYPE,
  DEFAULT_7K_PARTNER,
} from "./types";

import { ILendingProtocol } from "./protocols/interface";
import { SuilendAdapter } from "./protocols/suilend";
import { NaviAdapter } from "./protocols/navi";
import { ScallopFlashLoanClient } from "./lib/scallop";
import {
  buildLeverageTransaction,
  calculateLeveragePreview as calcPreview,
} from "./strategies/leverage";
import {
  buildDeleverageTransaction,
  calculateDeleverageEstimate,
} from "./strategies/deleverage";
import { normalizeCoinType, parseUnits } from "./lib/utils";
import { getReserveByCoinType, COIN_TYPES } from "./lib/suilend/const";

/**
 * DeFi Dash SDK - Main entry point
 *
 * @example
 * ```typescript
 * import { DefiDashSDK, LendingProtocol } from 'defi-dash-sdk';
 *
 * const sdk = new DefiDashSDK();
 * await sdk.initialize(suiClient, keypair);
 *
 * // Execute leverage strategy
 * const result = await sdk.leverage({
 *   protocol: LendingProtocol.Suilend,
 *   depositAsset: 'LBTC',
 *   depositAmount: '0.001',
 *   multiplier: 2.0,
 *   dryRun: true
 * });
 * ```
 */
export class DefiDashSDK {
  private suiClient!: SuiClient;
  private keypair!: Ed25519Keypair;
  private flashLoanClient!: ScallopFlashLoanClient;
  private swapClient!: MetaAg;
  private protocols: Map<LendingProtocol, ILendingProtocol> = new Map();
  private initialized = false;
  private options: SDKOptions;

  constructor(options: SDKOptions = {}) {
    this.options = options;
  }

  /**
   * Initialize the SDK with Sui client and keypair
   */
  async initialize(
    suiClient: SuiClient,
    keypair: Ed25519Keypair
  ): Promise<void> {
    this.suiClient = suiClient;
    this.keypair = keypair;

    // Initialize flash loan client
    this.flashLoanClient = new ScallopFlashLoanClient();

    // Initialize swap client
    this.swapClient = new MetaAg({
      partner: this.options.swapPartner || DEFAULT_7K_PARTNER,
    });

    // Initialize protocol adapters
    const suilend = new SuilendAdapter();
    await suilend.initialize(suiClient);
    this.protocols.set(LendingProtocol.Suilend, suilend);

    const navi = new NaviAdapter();
    await navi.initialize(suiClient);
    this.protocols.set(LendingProtocol.Navi, navi);

    this.initialized = true;
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error("SDK not initialized. Call initialize() first.");
    }
  }

  private getProtocol(protocol: LendingProtocol): ILendingProtocol {
    const adapter = this.protocols.get(protocol);
    if (!adapter) {
      throw new Error(`Protocol ${protocol} not supported`);
    }
    return adapter;
  }

  private get userAddress(): string {
    return this.keypair.getPublicKey().toSuiAddress();
  }

  /**
   * Resolve asset symbol to coin type
   */
  private resolveCoinType(asset: string): string {
    // If already a full coin type, normalize it
    if (asset.includes("::")) {
      return normalizeCoinType(asset);
    }

    // Look up by symbol
    const upperSymbol = asset.toUpperCase();
    const coinType = (COIN_TYPES as any)[upperSymbol];
    if (coinType) {
      return normalizeCoinType(coinType);
    }

    throw new Error(`Unknown asset symbol: ${asset}`);
  }

  // ============================================================================
  // Strategy Methods
  // ============================================================================

  /**
   * Execute leverage strategy
   *
   * Opens a leveraged position by:
   * 1. Flash loaning USDC
   * 2. Swapping to deposit asset
   * 3. Depositing as collateral
   * 4. Borrowing USDC to repay flash loan
   */
  async leverage(params: LeverageParams): Promise<StrategyResult> {
    this.ensureInitialized();

    const protocol = this.getProtocol(params.protocol);
    const coinType = this.resolveCoinType(params.depositAsset);
    const reserve = getReserveByCoinType(coinType);
    const decimals = reserve?.decimals || 8;

    // Parse amount
    const depositAmount = parseUnits(params.depositAmount, decimals);

    // Build transaction
    const tx = new Transaction();
    tx.setSender(this.userAddress);
    tx.setGasBudget(100_000_000);

    try {
      await buildLeverageTransaction(tx, {
        protocol,
        flashLoanClient: this.flashLoanClient,
        swapClient: this.swapClient,
        suiClient: this.suiClient,
        userAddress: this.userAddress,
        depositCoinType: coinType,
        depositAmount,
        multiplier: params.multiplier,
      });

      if (params.dryRun) {
        return this.dryRun(tx);
      }

      return this.execute(tx);
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  /**
   * Execute deleverage strategy
   *
   * Closes a leveraged position by:
   * 1. Flash loaning USDC to repay debt
   * 2. Withdrawing collateral
   * 3. Swapping collateral to USDC
   * 4. Repaying flash loan
   * 5. Returning remaining assets to user
   */
  async deleverage(params: DeleverageParams): Promise<StrategyResult> {
    this.ensureInitialized();

    const protocol = this.getProtocol(params.protocol);

    // Get current position
    const position = await protocol.getPosition(this.userAddress);
    if (!position) {
      return {
        success: false,
        error: "No position found to deleverage",
      };
    }

    if (position.debt.amount === 0n) {
      return {
        success: false,
        error: "No debt to repay. Use withdraw instead.",
      };
    }

    // Build transaction
    const tx = new Transaction();
    tx.setSender(this.userAddress);
    tx.setGasBudget(100_000_000);

    try {
      await buildDeleverageTransaction(tx, {
        protocol,
        flashLoanClient: this.flashLoanClient,
        swapClient: this.swapClient,
        suiClient: this.suiClient,
        userAddress: this.userAddress,
        position,
      });

      if (params.dryRun) {
        return this.dryRun(tx);
      }

      return this.execute(tx);
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  // ============================================================================
  // Position Methods
  // ============================================================================

  /**
   * Get current lending position
   */
  async getPosition(protocol: LendingProtocol): Promise<PositionInfo | null> {
    this.ensureInitialized();
    return this.getProtocol(protocol).getPosition(this.userAddress);
  }

  /**
   * Check if user has a position on specified protocol
   */
  async hasPosition(protocol: LendingProtocol): Promise<boolean> {
    this.ensureInitialized();
    return this.getProtocol(protocol).hasPosition(this.userAddress);
  }

  // ============================================================================
  // Preview Methods
  // ============================================================================

  /**
   * Preview leverage position before execution
   */
  async previewLeverage(params: {
    depositAsset: string;
    depositAmount: string;
    multiplier: number;
  }): Promise<LeveragePreview> {
    const coinType = this.resolveCoinType(params.depositAsset);
    const reserve = getReserveByCoinType(coinType);
    const decimals = reserve?.decimals || 8;
    const depositAmount = parseUnits(params.depositAmount, decimals);

    return calcPreview({
      depositCoinType: coinType,
      depositAmount,
      multiplier: params.multiplier,
    });
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get token price in USD
   */
  async getTokenPrice(asset: string): Promise<number> {
    const coinType = this.resolveCoinType(asset);
    return getTokenPrice(coinType);
  }

  /**
   * Get wallet balances
   */
  async getBalances(): Promise<
    Array<{ coinType: string; symbol: string; balance: string }>
  > {
    this.ensureInitialized();
    const balances = await this.suiClient.getAllBalances({
      owner: this.userAddress,
    });

    return balances
      .filter((b) => Number(b.totalBalance) > 0)
      .map((b) => ({
        coinType: b.coinType,
        symbol: b.coinType.split("::").pop() || "???",
        balance: b.totalBalance,
      }));
  }

  // ============================================================================
  // Internal Methods
  // ============================================================================

  private async dryRun(tx: Transaction): Promise<StrategyResult> {
    const result = await this.suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: this.suiClient }),
    });

    if (result.effects.status.status === "success") {
      return {
        success: true,
        gasUsed: BigInt(result.effects.gasUsed.computationCost),
      };
    }

    return {
      success: false,
      error: result.effects.status.error || "Dry run failed",
    };
  }

  private async execute(tx: Transaction): Promise<StrategyResult> {
    const result = await this.suiClient.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
      options: {
        showEffects: true,
      },
    });

    if (result.effects?.status.status === "success") {
      return {
        success: true,
        txDigest: result.digest,
        gasUsed: BigInt(result.effects.gasUsed.computationCost),
      };
    }

    return {
      success: false,
      txDigest: result.digest,
      error: result.effects?.status.error || "Execution failed",
    };
  }
}
