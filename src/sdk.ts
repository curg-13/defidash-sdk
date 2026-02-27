/**
 * DeFi Dash SDK - Main SDK Class
 *
 * Multi-protocol DeFi SDK for Sui blockchain
 * Supports both Node.js (with keypair) and Browser (with wallet adapter)
 */

import { SuiClient } from "@mysten/sui/client";
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
  DEFAULT_7K_PARTNER,
  AccountPortfolio,
  ILendingProtocol,
  BrowserLeverageParams,
  BrowserDeleverageParams,
  COIN_TYPES,
  FindBestRouteParams,
  LeverageRouteResult,
} from "./types";

import { SuilendAdapter } from "./protocols/suilend/adapter";
import { NaviAdapter } from "./protocols/navi/adapter";
import { ScallopAdapter } from "./protocols/scallop/adapter";
import { ScallopFlashLoanClient } from "./protocols/scallop/flash-loan";
import { normalizeCoinType, parseUnits } from "./utils";
import {
  DRYRUN_GAS_BUDGET,
  calculateActualGas,
  calculateOptimizedBudget,
} from "./utils/gas";
import {
  SDKNotInitializedError,
  UnsupportedProtocolError,
  UnknownAssetError,
  PositionNotFoundError,
  NoDebtError,
  InvalidParameterError,
  KeypairRequiredError,
} from "./utils/errors";
import { buildLeverageTransaction as buildLeverageTx } from "./strategies/leverage";
import { buildDeleverageTransaction as buildDeleverageTx } from "./strategies/deleverage";
import { previewLeverage as previewLeverageFn } from "./strategies/leverage-preview";
import { findBestLeverageRoute as findBestLeverageRouteFn } from "./strategies/leverage-route";
import { buildScallopLeverageTransaction } from "./strategies/scallop-leverage";
import { getReserveByCoinType } from "./protocols/suilend/constants";

/**
 * DeFi Dash SDK - Main entry point
 *
 * @example Node.js usage:
 * ```typescript
 * const sdk = new DefiDashSDK();
 * await sdk.initialize(suiClient, keypair);
 * const result = await sdk.leverage({ protocol: LendingProtocol.Suilend, ... });
 * ```
 *
 * @example Browser usage:
 * ```typescript
 * const sdk = new DefiDashSDK();
 * await sdk.initialize(suiClient, userAddress);  // No keypair needed
 *
 * const tx = new Transaction();
 * tx.setSender(userAddress);
 * await sdk.buildLeverageTransaction(tx, { protocol, depositAsset, ... });
 *
 * // Sign with wallet adapter
 * await signAndExecute({ transaction: tx });
 * ```
 */
export class DefiDashSDK {
  private suiClient!: SuiClient;
  private keypair?: Ed25519Keypair; // Optional for browser
  private _userAddress?: string; // For browser mode
  private flashLoanClient!: ScallopFlashLoanClient;
  private swapClient!: MetaAg;
  private protocols: Map<LendingProtocol, ILendingProtocol> = new Map();
  private initialized = false;
  private options: SDKOptions;

  constructor(options: SDKOptions = {}) {
    this.options = options;
  }

  /**
   * Initialize the SDK
   *
   * @param suiClient - Sui client instance
   * @param keypairOrAddress - Ed25519Keypair (Node.js) or user address string (Browser)
   *
   * @example Node.js
   * ```typescript
   * await sdk.initialize(suiClient, keypair);
   * ```
   *
   * @example Browser
   * ```typescript
   * await sdk.initialize(suiClient, account.address);
   * ```
   */
  async initialize(
    suiClient: SuiClient,
    keypairOrAddress: Ed25519Keypair | string,
  ): Promise<void> {
    this.suiClient = suiClient;

    // Detect if keypair or address
    if (typeof keypairOrAddress === "string") {
      // Browser mode: address only
      this._userAddress = keypairOrAddress;
    } else {
      // Node.js mode: keypair
      this.keypair = keypairOrAddress;
      this._userAddress = keypairOrAddress.getPublicKey().toSuiAddress();
    }

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

    const scallop = new ScallopAdapter();
    await scallop.initialize(suiClient);
    this.protocols.set(LendingProtocol.Scallop, scallop);

    // Initialize flash loan client with Scallop's addresses (always up-to-date)
    const scallopAddresses = scallop.getAddresses();
    this.flashLoanClient = new ScallopFlashLoanClient({
      protocolPkg: scallopAddresses.core.protocolPkg,
      version: scallopAddresses.core.version,
      market: scallopAddresses.core.market,
    });

    this.initialized = true;
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new SDKNotInitializedError();
    }
  }

  private getProtocol(protocol: LendingProtocol): ILendingProtocol {
    const adapter = this.protocols.get(protocol);
    if (!adapter) {
      throw new UnsupportedProtocolError(protocol);
    }
    return adapter;
  }

  private get userAddress(): string {
    if (!this._userAddress) {
      throw new SDKNotInitializedError();
    }
    return this._userAddress;
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
    const coinType = COIN_TYPES[upperSymbol as keyof typeof COIN_TYPES];
    if (coinType) {
      return normalizeCoinType(coinType);
    }

    throw new UnknownAssetError(asset);
  }

  // ============================================================================
  // Browser-Compatible Transaction Builder Methods
  // ============================================================================

  /**
   * Build leverage transaction (Browser-compatible)
   *
   * Builds the transaction but does NOT execute it.
   * Use with wallet adapter's signAndExecute.
   *
   * @param tx - Transaction to add commands to
   * @param params - Leverage parameters
   *
   * @example
   * ```typescript
   * const tx = new Transaction();
   * tx.setSender(account.address);
   * tx.setGasBudget(200_000_000);
   *
   * await sdk.buildLeverageTransaction(tx, {
   *   protocol: LendingProtocol.Suilend,
   *   depositAsset: 'LBTC',
   *   depositAmount: '0.001',
   *   multiplier: 2.0,
   * });
   *
   * await signAndExecute({ transaction: tx });
   * ```
   */
  async buildLeverageTransaction(
    tx: Transaction,
    params: BrowserLeverageParams,
  ): Promise<void> {
    this.ensureInitialized();

    // Validate that exactly one of depositAmount or depositValueUsd is provided
    if (!params.depositAmount && !params.depositValueUsd) {
      throw new InvalidParameterError(
        "Either depositAmount or depositValueUsd must be provided",
      );
    }
    if (params.depositAmount && params.depositValueUsd) {
      throw new InvalidParameterError(
        "Cannot provide both depositAmount and depositValueUsd. Choose one.",
      );
    }

    const protocol = this.getProtocol(params.protocol);

    // Clear adapter state for new transaction (Scallop tracks unstaked obligations)
    if (params.protocol === LendingProtocol.Scallop) {
      protocol.clearPendingState?.();
    }

    const coinType = this.resolveCoinType(params.depositAsset);
    const reserve = getReserveByCoinType(coinType);
    const decimals = reserve?.decimals || 8;

    // Convert depositValueUsd to depositAmount if needed
    let depositAmountStr: string;
    if (params.depositValueUsd) {
      const price = await getTokenPrice(coinType);
      const amountInToken = params.depositValueUsd / price;
      depositAmountStr = amountInToken.toFixed(decimals);
    } else {
      depositAmountStr = params.depositAmount!;
    }

    const depositAmount = parseUnits(depositAmountStr, decimals);

    await buildLeverageTx(tx, {
      protocol,
      flashLoanClient: this.flashLoanClient,
      swapClient: this.swapClient,
      suiClient: this.suiClient,
      userAddress: this.userAddress,
      depositCoinType: coinType,
      depositAmount,
      multiplier: params.multiplier,
    });
  }

  /**
   * Build deleverage transaction (Browser-compatible)
   *
   * Builds the transaction but does NOT execute it.
   * Use with wallet adapter's signAndExecute.
   *
   * @param tx - Transaction to add commands to
   * @param params - Deleverage parameters
   *
   * @example
   * ```typescript
   * const tx = new Transaction();
   * tx.setSender(account.address);
   * tx.setGasBudget(200_000_000);
   *
   * await sdk.buildDeleverageTransaction(tx, {
   *   protocol: LendingProtocol.Suilend,
   * });
   *
   * await signAndExecute({ transaction: tx });
   * ```
   */
  async buildDeleverageTransaction(
    tx: Transaction,
    params: BrowserDeleverageParams,
  ): Promise<void> {
    this.ensureInitialized();

    const protocol = this.getProtocol(params.protocol);

    // Clear adapter state for new transaction (Scallop tracks unstaked obligations)
    if (params.protocol === LendingProtocol.Scallop) {
      protocol.clearPendingState?.();
    }

    // Get current position
    const position = await protocol.getPosition(this.userAddress);
    if (!position) {
      throw new PositionNotFoundError(params.protocol);
    }

    if (position.debt.amount === 0n) {
      throw new NoDebtError();
    }

    await buildDeleverageTx(tx, {
      protocol,
      flashLoanClient: this.flashLoanClient,
      swapClient: this.swapClient,
      suiClient: this.suiClient,
      userAddress: this.userAddress,
      position,
    });
  }

  // ============================================================================
  // Node.js Strategy Methods (with execution)
  // ============================================================================

  /**
   * Execute leverage strategy (Node.js only)
   *
   * Opens a leveraged position by:
   * 1. Taking a flash loan
   * 2. Swapping borrowed USDC for deposit asset
   * 3. Depositing total collateral (user deposit + swapped amount)
   * 4. Borrowing USDC to repay flash loan
   *
   * @param params - Leverage parameters
   * @param params.protocol - Lending protocol to use (Suilend, Scallop, or Navi)
   * @param params.depositAsset - Asset symbol (e.g., "SUI", "LBTC") or full coin type
   * @param params.depositAmount - Amount to deposit (required if depositValueUsd not provided)
   * @param params.depositValueUsd - USD value to deposit (required if depositAmount not provided)
   * @param params.multiplier - Leverage multiplier (e.g., 2.0 for 2x leverage)
   * @param params.dryRun - If true, simulates transaction and returns gas estimate without executing
   *
   * @returns Strategy result with success status, transaction digest (if executed), and gas used
   *
   * @throws {SDKNotInitializedError} If SDK not initialized
   * @throws {KeypairRequiredError} If keypair not provided (Node.js mode required)
   * @throws {InvalidParameterError} If both or neither depositAmount and depositValueUsd provided
   * @throws {UnknownAssetError} If asset symbol not recognized
   *
   * @example
   * ```typescript
   * // Leverage with fixed amount
   * const result = await sdk.leverage({
   *   protocol: LendingProtocol.Suilend,
   *   depositAsset: 'LBTC',
   *   depositAmount: '0.001',
   *   multiplier: 2.0,
   *   dryRun: true
   * });
   *
   * // Leverage with USD value
   * const result = await sdk.leverage({
   *   protocol: LendingProtocol.Scallop,
   *   depositAsset: 'SUI',
   *   depositValueUsd: 100,  // $100 worth of SUI
   *   multiplier: 3.0,
   *   dryRun: false
   * });
   * ```
   *
   * @remarks
   * - Requires SDK to be initialized with keypair (Node.js mode)
   * - For browser usage, use {@link buildLeverageTransaction} instead
   * - Scallop protocol uses optimized native SDK for oracle updates
   * - Gas is automatically optimized via dry run (20% buffer added)
   */
  async leverage(params: LeverageParams): Promise<StrategyResult> {
    this.ensureInitialized();

    if (!this.keypair) {
      return {
        success: false,
        error:
          "Keypair required for execution. Use buildLeverageTransaction for browser.",
      };
    }

    // Scallop uses its own SDK builder for oracle updates
    if (params.protocol === LendingProtocol.Scallop) {
      return this.executeScallopLeverage(params);
    }

    const tx = new Transaction();
    tx.setSender(this.userAddress);

    try {
      await this.buildLeverageTransaction(tx, params);

      if (params.dryRun) {
        return this.dryRunWithGasOptimization(tx);
      }

      // execute() runs dryrun first and optimizes gas budget
      return this.execute(tx);
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }

  /**
   * Execute deleverage strategy (Node.js only)
   *
   * Closes or reduces a leveraged position by:
   * 1. Taking a flash loan to repay debt
   * 2. Withdrawing collateral
   * 3. Swapping portion of collateral to USDC
   * 4. Repaying flash loan
   * 5. Keeping remaining collateral
   *
   * @param params - Deleverage parameters
   * @param params.protocol - Lending protocol where position exists
   * @param params.dryRun - If true, simulates transaction without executing
   *
   * @returns Strategy result with success status, transaction digest, and gas used
   *
   * @throws {SDKNotInitializedError} If SDK not initialized
   * @throws {KeypairRequiredError} If keypair not provided (Node.js mode required)
   * @throws {PositionNotFoundError} If no position exists on the protocol
   * @throws {NoDebtError} If position has no debt (use withdraw instead)
   *
   * @example
   * ```typescript
   * // Dry run first to preview
   * const preview = await sdk.deleverage({
   *   protocol: LendingProtocol.Suilend,
   *   dryRun: true
   * });
   *
   * if (preview.success) {
   *   console.log(`Estimated gas: ${preview.gasUsed}`);
   *
   *   // Execute for real
   *   const result = await sdk.deleverage({
   *     protocol: LendingProtocol.Suilend,
   *     dryRun: false
   *   });
   *
   *   if (result.success) {
   *     console.log(`Position closed: ${result.txDigest}`);
   *   }
   * }
   * ```
   *
   * @remarks
   * - Requires SDK to be initialized with keypair (Node.js mode)
   * - For browser usage, use {@link buildDeleverageTransaction} instead
   * - Automatically fetches current position and calculates optimal swap amounts
   * - Gas is automatically optimized via dry run (20% buffer added)
   */
  async deleverage(params: DeleverageParams): Promise<StrategyResult> {
    this.ensureInitialized();

    if (!this.keypair) {
      return {
        success: false,
        error:
          "Keypair required for execution. Use buildDeleverageTransaction for browser.",
      };
    }

    const tx = new Transaction();
    tx.setSender(this.userAddress);

    try {
      await this.buildDeleverageTransaction(tx, params);

      if (params.dryRun) {
        return this.dryRunWithGasOptimization(tx);
      }

      // execute() runs dryrun first and optimizes gas budget
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
   * Get current lending position on a specific protocol
   *
   * @param protocol - The lending protocol to query
   *
   * @returns Position information including collateral, debt, and metrics, or null if no position exists
   *
   * @throws {SDKNotInitializedError} If SDK not initialized
   * @throws {UnsupportedProtocolError} If protocol not supported
   *
   * @example
   * ```typescript
   * const position = await sdk.getPosition(LendingProtocol.Suilend);
   *
   * if (position) {
   *   console.log(`Collateral: ${position.collateral.amount} ${position.collateral.symbol}`);
   *   console.log(`Debt: ${position.debt.amount} ${position.debt.symbol}`);
   *   console.log(`Health Factor: ${position.healthFactor}`);
   *   console.log(`Net Value: $${position.netValueUsd}`);
   * } else {
   *   console.log('No position found');
   * }
   * ```
   */
  async getPosition(protocol: LendingProtocol): Promise<PositionInfo | null> {
    this.ensureInitialized();
    return this.getProtocol(protocol).getPosition(this.userAddress);
  }

  // ============================================================================
  // Aggregation Methods
  // ============================================================================

  /**
   * Get aggregated portfolio data from all supported protocols
   *
   * Fetches positions and metrics from Suilend, Navi, and Scallop protocols concurrently.
   * Resilient to individual protocol failures - returns default values if a protocol fetch fails.
   *
   * @returns Array of portfolio data for each protocol
   *
   * @throws {SDKNotInitializedError} If SDK not initialized
   *
   * @example
   * ```typescript
   * const portfolios = await sdk.getAggregatedPortfolio();
   *
   * for (const portfolio of portfolios) {
   *   console.log(`\nProtocol: ${portfolio.protocol}`);
   *   console.log(`Net Value: $${portfolio.netValueUsd.toFixed(2)}`);
   *   console.log(`Health Factor: ${portfolio.healthFactor}`);
   *   console.log(`Collateral: $${portfolio.totalCollateralUsd.toFixed(2)}`);
   *   console.log(`Debt: $${portfolio.totalDebtUsd.toFixed(2)}`);
   *
   *   if (portfolio.positions.length > 0) {
   *     console.log(`Active positions: ${portfolio.positions.length}`);
   *   }
   * }
   * ```
   *
   * @remarks
   * - Queries all protocols in parallel for better performance
   * - Returns default empty portfolio if protocol query fails
   * - Health factor of Infinity indicates no debt (risk-free)
   */
  async getAggregatedPortfolio(): Promise<AccountPortfolio[]> {
    this.ensureInitialized();
    const protocols = [
      LendingProtocol.Suilend,
      LendingProtocol.Navi,
      LendingProtocol.Scallop,
    ];
    const address = this.userAddress;

    const portfolios = await Promise.all(
      protocols.map(async (p) => {
        try {
          const adapter = this.protocols.get(p);
          if (adapter) {
            return await adapter.getAccountPortfolio(address);
          }
        } catch (e) {
          // Silently skip failed protocol fetches
        }
        // Return resilient default
        return {
          protocol: p,
          address,
          healthFactor: Infinity,
          netValueUsd: 0,
          totalCollateralUsd: 0,
          totalDebtUsd: 0,
          positions: [],
        } as AccountPortfolio;
      }),
    );

    return portfolios;
  }

  // ============================================================================
  // Preview Methods
  // ============================================================================

  /**
   * Preview leverage position before execution
   *
   * Calculates expected position metrics without executing a transaction.
   * Useful for showing users what their leveraged position will look like.
   *
   * @param params - Preview parameters
   * @param params.protocol - Lending protocol to use (suilend, navi, scallop)
   * @param params.depositAsset - Asset symbol (e.g., "SUI", "LBTC") or full coin type
   * @param params.depositAmount - Amount to deposit (required if depositValueUsd not provided)
   * @param params.depositValueUsd - USD value to deposit (required if depositAmount not provided)
   * @param params.multiplier - Target leverage multiplier (e.g., 2.0 for 2x)
   *
   * @returns Preview containing position metrics, flash loan details, and risk parameters
   *
   * @throws {InvalidParameterError} If both or neither depositAmount and depositValueUsd provided
   * @throws {InvalidParameterError} If multiplier exceeds protocol's max multiplier
   * @throws {UnknownAssetError} If asset symbol not recognized
   *
   * @example
   * ```typescript
   * // Preview with fixed amount
   * const preview = await sdk.previewLeverage({
   *   protocol: 'suilend',
   *   depositAsset: 'LBTC',
   *   depositAmount: '0.001',
   *   multiplier: 2.0
   * });
   *
   * console.log(`Initial Equity: $${preview.initialEquityUsd}`);
   * console.log(`Flash Loan: ${preview.flashLoanUsdc / 1e6} USDC`);
   * console.log(`Total Position: $${preview.totalPositionUsd}`);
   * console.log(`Position LTV: ${preview.ltvPercent.toFixed(1)}%`);
   * console.log(`Max Multiplier: ${preview.maxMultiplier.toFixed(2)}x`);
   * console.log(`Liquidation Price: $${preview.liquidationPrice}`);
   * console.log(`Price Drop Buffer: ${preview.priceDropBuffer.toFixed(1)}%`);
   *
   * // Preview with USD value
   * const preview2 = await sdk.previewLeverage({
   *   protocol: 'scallop',
   *   depositAsset: 'SUI',
   *   depositValueUsd: 100,  // $100 worth
   *   multiplier: 3.0
   * });
   * ```
   *
   * @remarks
   * - Queries protocol-specific LTV to calculate accurate max multiplier
   * - Max multiplier = 1 / (1 - LTV), e.g., 65% LTV → 2.857x max
   * - Fetches current market prices from 7k Protocol
   * - Calculations are estimates; actual execution may differ slightly
   * - Higher multipliers increase both returns and liquidation risk
   */
  async previewLeverage(params: {
    protocol: LendingProtocol;
    depositAsset: string;
    depositAmount?: string;
    depositValueUsd?: number;
    multiplier: number;
  }): Promise<LeveragePreview> {
    const protocol = this.getProtocol(params.protocol);
    const coinType = this.resolveCoinType(params.depositAsset);

    return previewLeverageFn(
      {
        coinType,
        depositAmount: params.depositAmount,
        depositValueUsd: params.depositValueUsd,
        multiplier: params.multiplier,
      },
      {
        protocol,
        swapClient: this.swapClient,
        suiClient: this.suiClient,
      },
    );
  }

  // ============================================================================
  // Route Finding
  // ============================================================================

  /**
   * Find the best leverage route across all initialized protocols for a given asset.
   *
   * Returns two recommendations:
   * 1. **bestMaxMultiplier** — the protocol offering the highest possible leverage
   * 2. **bestApy** — the protocol with the highest net APY at a safe multiplier
   *
   * The safe multiplier = min(maxMultiplier across protocols) - LEVERAGE_MULTIPLIER_BUFFER
   *
   * @example
   * ```typescript
   * const route = await sdk.findBestLeverageRoute({
   *   depositAsset: 'SUI',
   *   depositValueUsd: 100,
   * });
   *
   * console.log(route.bestMaxMultiplier.protocol); // e.g. 'scallop'
   * console.log(route.bestApy.protocol);           // e.g. 'suilend'
   * console.log(route.safeMultiplier);             // e.g. 2.83
   * ```
   */
  async findBestLeverageRoute(
    params: FindBestRouteParams,
  ): Promise<LeverageRouteResult> {
    this.ensureInitialized();

    return findBestLeverageRouteFn(params, {
      protocols: this.protocols,
      previewFn: (protocol, previewParams) =>
        this.previewLeverage({
          protocol,
          ...previewParams,
        }),
      resolveCoinType: (asset) => this.resolveCoinType(asset),
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
   * Get the SuiClient instance
   */
  getSuiClient(): SuiClient {
    this.ensureInitialized();
    return this.suiClient;
  }

  /**
   * Get the user address
   */
  getUserAddress(): string {
    return this.userAddress;
  }

  // ============================================================================
  // Internal Methods
  // ============================================================================

  /**
   * Dry run with gas optimization
   *
   * Uses small fixed budget for dryrun, returns actual gas estimation.
   */
  private async dryRunWithGasOptimization(
    tx: Transaction,
  ): Promise<StrategyResult> {
    // Use small fixed budget for dryrun simulation
    tx.setGasBudget(DRYRUN_GAS_BUDGET);

    const result = await this.suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: this.suiClient }),
    });

    if (result.effects.status.status === "success") {
      const actualGas = calculateActualGas(result.effects.gasUsed);
      const optimizedBudget = calculateOptimizedBudget(actualGas);

      return {
        success: true,
        gasUsed: optimizedBudget,
      };
    }

    return {
      success: false,
      error: result.effects.status.error || "Dry run failed",
    };
  }

  /**
   * Execute transaction with gas optimization
   *
   * Flow:
   * 1. Dryrun with small fixed budget to get actual gas usage
   * 2. Calculate optimized budget (actual + 20% buffer)
   * 3. Check user has enough balance
   * 4. Execute with optimized budget
   *
   * This ensures we never overpay for gas.
   */
  private async execute(tx: Transaction): Promise<StrategyResult> {
    if (!this.keypair) {
      throw new KeypairRequiredError();
    }

    // Step 1: Check user's available gas balance first
    const balance = await this.suiClient.getBalance({
      owner: this.userAddress,
    });
    const userBalance = BigInt(balance.totalBalance);

    // Step 2: Set dryrun budget (use available balance or default, whichever is lower)
    const dryrunBudget =
      userBalance < BigInt(DRYRUN_GAS_BUDGET)
        ? userBalance
        : BigInt(DRYRUN_GAS_BUDGET);

    if (dryrunBudget < 10_000_000n) {
      // Min 0.01 SUI for dryrun
      return {
        success: false,
        error: `Insufficient balance for gas. Have: ${Number(userBalance) / 1e9} SUI`,
      };
    }

    tx.setGasBudget(dryrunBudget);

    const dryRunResult = await this.suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: this.suiClient }),
    });

    if (dryRunResult.effects.status.status !== "success") {
      return {
        success: false,
        error: `Dry run failed: ${dryRunResult.effects.status.error}`,
      };
    }

    // Step 3: Calculate optimized gas budget (actual + 20% buffer)
    const actualGas = calculateActualGas(dryRunResult.effects.gasUsed);
    const optimizedBudget = calculateOptimizedBudget(actualGas);

    // Step 4: Check if user has enough balance for actual execution
    if (userBalance < optimizedBudget) {
      return {
        success: false,
        error: `Insufficient balance for gas. Need: ${Number(optimizedBudget) / 1e9} SUI, Have: ${Number(userBalance) / 1e9} SUI`,
      };
    }

    // Step 4: Execute with optimized gas budget
    tx.setGasBudget(optimizedBudget);

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

  // ============================================================================
  // Scallop-Specific Methods (uses Scallop SDK builder for oracle updates)
  // ============================================================================

  /**
   * Execute Scallop leverage using native Scallop SDK builder
   *
   * Scallop requires oracle price updates via their SDK's updateAssetPricesQuick.
   * This method uses the Scallop SDK builder internally.
   */
  private async executeScallopLeverage(
    params: LeverageParams,
  ): Promise<StrategyResult> {
    if (!this.keypair) {
      return { success: false, error: "Keypair required" };
    }

    if (!this.options.secretKey) {
      return {
        success: false,
        error:
          "Scallop operations require secretKey in SDK options. Pass { secretKey: 'suiprivkey...' } to DefiDashSDK constructor.",
      };
    }

    try {
      const coinType = this.resolveCoinType(params.depositAsset);

      const { tx, builder } = await buildScallopLeverageTransaction(
        {
          coinType,
          depositAmount: params.depositAmount,
          depositValueUsd: params.depositValueUsd,
          multiplier: params.multiplier,
          userAddress: this.userAddress,
          secretKey: this.options.secretKey,
        },
        {
          suiClient: this.suiClient,
          swapClient: this.swapClient,
        },
      );

      // Dry run
      if (params.dryRun) {
        tx.txBlock.setGasBudget(DRYRUN_GAS_BUDGET);
        const dryRunResult = await this.suiClient.dryRunTransactionBlock({
          transactionBlock: await tx.txBlock.build({ client: this.suiClient }),
        });

        if (dryRunResult.effects.status.status === "success") {
          const actualGas = calculateActualGas(dryRunResult.effects.gasUsed);
          const optimizedBudget = calculateOptimizedBudget(actualGas);
          return { success: true, gasUsed: optimizedBudget };
        }
        return {
          success: false,
          error: dryRunResult.effects.status.error || "Dry run failed",
        };
      }

      // Real execution: dryrun first to optimize gas
      tx.txBlock.setGasBudget(DRYRUN_GAS_BUDGET);
      const dryRunResult = await this.suiClient.dryRunTransactionBlock({
        transactionBlock: await tx.txBlock.build({ client: this.suiClient }),
      });

      if (dryRunResult.effects.status.status !== "success") {
        return {
          success: false,
          error: `Dry run failed: ${dryRunResult.effects.status.error}`,
        };
      }

      const actualGas = calculateActualGas(dryRunResult.effects.gasUsed);
      const optimizedBudget = calculateOptimizedBudget(actualGas);
      tx.txBlock.setGasBudget(optimizedBudget);

      const result = await builder.signAndSendTxBlock(tx);

      const txDetails = await this.suiClient.waitForTransaction({
        digest: result.digest,
        options: { showEffects: true },
      });

      const gasUsed = txDetails.effects?.gasUsed
        ? BigInt(txDetails.effects.gasUsed.computationCost)
        : actualGas;

      return {
        success: true,
        txDigest: result.digest,
        gasUsed,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
  }
}
