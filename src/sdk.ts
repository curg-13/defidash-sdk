/**
 * DeFi Dash SDK - Main SDK Class
 *
 * Multi-protocol DeFi SDK for Sui blockchain
 * Supports both Node.js (with keypair) and Browser (with wallet adapter)
 */

import { SuiClient } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { MetaAg, getTokenPrice } from '@7kprotocol/sdk-ts';

import {
  LendingProtocol,
  PositionInfo,
  StrategyResult,
  LeveragePreview,
  SDKOptions,
  DEFAULT_7K_PARTNER,
  AccountPortfolio,
  ILendingProtocol,
  BrowserLeverageParams,
  BrowserDeleverageParams,
  FindBestRouteParams,
  LeverageRouteResult,
  AssetLeverageInfo,
} from './types';

import { SuilendAdapter } from './protocols/suilend/adapter';
import { NaviAdapter } from './protocols/navi/adapter';
import { ScallopAdapter } from './protocols/scallop/adapter';
import { ScallopFlashLoanClient } from './protocols/scallop/flash-loan';
import { resolveCoinType, parseUnits, getDecimals } from './utils';
import {
  SDKNotInitializedError,
  UnsupportedProtocolError,
  PositionNotFoundError,
  NoDebtError,
  InvalidParameterError,
  KeypairRequiredError,
} from './utils/errors';
import { dryRunTransaction, executeTransaction } from './utils/execution';
import { buildLeverageTransaction as buildLeverageTx } from './strategies/leverage';
import { buildDeleverageTransaction as buildDeleverageTx } from './strategies/deleverage';
import { previewLeverage as previewLeverageFn } from './strategies/leverage-preview';
import { findBestLeverageRoute as findBestLeverageRouteFn } from './strategies/leverage-route';

/**
 * DeFi Dash SDK - Main entry point
 *
 * @example Node.js usage (build + execute):
 * ```typescript
 * const sdk = await DefiDashSDK.create(suiClient, keypair);
 *
 * const tx = new Transaction();
 * tx.setSender(address);
 * await sdk.buildLeverageTransaction(tx, { protocol, depositAsset, ... });
 * const result = await sdk.execute(tx);   // or sdk.dryRun(tx)
 * ```
 *
 * @example Browser usage:
 * ```typescript
 * const sdk = await DefiDashSDK.create(suiClient, userAddress);
 *
 * const tx = new Transaction();
 * tx.setSender(userAddress);
 * await sdk.buildLeverageTransaction(tx, { protocol, depositAsset, ... });
 * await signAndExecute({ transaction: tx }); // wallet adapter
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

  private constructor(options: SDKOptions = {}) {
    this.options = options;
  }

  /**
   * Create and initialize the SDK in one step (recommended).
   *
   * @param suiClient - Sui client instance
   * @param keypairOrAddress - Ed25519Keypair (Node.js) or user address string (Browser)
   * @param options - SDK options
   *
   * @example Node.js
   * ```typescript
   * const sdk = await DefiDashSDK.create(suiClient, keypair);
   * ```
   *
   * @example Browser
   * ```typescript
   * const sdk = await DefiDashSDK.create(suiClient, account.address);
   * ```
   */
  static async create(
    suiClient: SuiClient,
    keypairOrAddress: Ed25519Keypair | string,
    options: SDKOptions = {},
  ): Promise<DefiDashSDK> {
    const sdk = new DefiDashSDK(options);
    await sdk.initialize(suiClient, keypairOrAddress);
    return sdk;
  }

  /**
   * Initialize the SDK (internal — use `DefiDashSDK.create()`)
   */
  private async initialize(
    suiClient: SuiClient,
    keypairOrAddress: Ed25519Keypair | string,
  ): Promise<void> {
    this.suiClient = suiClient;

    // Detect if keypair or address
    if (typeof keypairOrAddress === 'string') {
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

  /** Resolve asset symbol to coin type */
  private resolveCoinType(asset: string): string {
    return resolveCoinType(asset);
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
    const hasAmount = params.depositAmount != null;
    const hasValueUsd = params.depositValueUsd != null;
    if (!hasAmount && !hasValueUsd) {
      throw new InvalidParameterError(
        'Either depositAmount or depositValueUsd must be provided',
      );
    }
    if (hasAmount && hasValueUsd) {
      throw new InvalidParameterError(
        'Cannot provide both depositAmount and depositValueUsd. Choose one.',
      );
    }

    const protocol = this.getProtocol(params.protocol);

    // Clear adapter state for new transaction (Scallop tracks unstaked obligations)
    if (params.protocol === LendingProtocol.Scallop) {
      protocol.clearPendingState?.();
    }

    const coinType = this.resolveCoinType(params.depositAsset);
    const decimals = getDecimals(coinType);

    // Validate multiplier against protocol limits
    if (params.multiplier <= 1) {
      throw new InvalidParameterError(
        `Multiplier must be greater than 1 (got ${params.multiplier})`,
      );
    }

    const riskParams = await protocol.getAssetRiskParams(coinType);
    if (params.multiplier > riskParams.maxMultiplier) {
      throw new InvalidParameterError(
        `Multiplier ${params.multiplier}x exceeds protocol max ${riskParams.maxMultiplier.toFixed(2)}x (LTV ${(riskParams.ltv * 100).toFixed(0)}%)`,
      );
    }

    // Convert depositValueUsd to depositAmount if needed
    let depositAmountStr: string;
    if (hasValueUsd) {
      if (params.depositValueUsd! <= 0) {
        throw new InvalidParameterError('depositValueUsd must be positive');
      }
      const price = await getTokenPrice(coinType);
      const amountInToken = params.depositValueUsd! / price;
      depositAmountStr = amountInToken.toFixed(decimals);
    } else {
      depositAmountStr = params.depositAmount!;
    }

    const depositAmount = parseUnits(depositAmountStr, decimals);

    if (depositAmount <= 0n) {
      throw new InvalidParameterError('depositAmount must be positive');
    }

    await buildLeverageTx(tx, {
      protocol,
      flashLoanClient: this.flashLoanClient,
      swapClient: this.swapClient,
      suiClient: this.suiClient,
      userAddress: this.userAddress,
      depositCoinType: coinType,
      depositAmount,
      multiplier: params.multiplier,
      slippageBps: params.slippageBps,
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
      slippageBps: params.slippageBps,
    });
  }

  // ============================================================================
  // Position Methods
  // ============================================================================

  /**
   * Get position for a single protocol
   *
   * @param protocol - Lending protocol to query
   * @returns Position info or null if no active position
   *
   * @example
   * ```typescript
   * const position = await sdk.getPosition(LendingProtocol.Navi);
   * if (position) {
   *   console.log(`Collateral: ${position.collateral.symbol} $${position.collateral.valueUsd}`);
   *   console.log(`Debt: ${position.debt.symbol} $${position.debt.valueUsd}`);
   * }
   * ```
   */
  async getPosition(protocol: LendingProtocol): Promise<PositionInfo | null> {
    this.ensureInitialized();
    return this.getProtocol(protocol).getPosition(this.userAddress);
  }

  /**
   * Get all open positions across all supported protocols
   *
   * Queries Suilend, Navi, and Scallop in parallel and returns
   * only the protocols that have an active position (collateral > 0 or debt > 0).
   *
   * @returns Array of open positions with protocol identifier
   *
   * @example
   * ```typescript
   * const positions = await sdk.getOpenPositions();
   *
   * for (const { protocol, position } of positions) {
   *   console.log(`${protocol}: ${position.collateral.symbol} $${position.collateral.valueUsd.toFixed(2)}`);
   *   if (position.debt.amount > 0n) {
   *     console.log(`  Debt: ${position.debt.symbol} $${position.debt.valueUsd.toFixed(2)}`);
   *   }
   *   console.log(`  Net: $${position.netValueUsd.toFixed(2)}`);
   * }
   * ```
   */
  async getOpenPositions(): Promise<
    Array<{ protocol: LendingProtocol; position: PositionInfo }>
  > {
    this.ensureInitialized();

    const allProtocols = [
      LendingProtocol.Suilend,
      LendingProtocol.Navi,
      LendingProtocol.Scallop,
    ];

    const results = await Promise.all(
      allProtocols.map(async (p) => {
        try {
          const position = await this.getProtocol(p).getPosition(
            this.userAddress,
          );
          return position ? { protocol: p, position } : null;
        } catch (e) {
          console.warn(`[DefiDashSDK] Failed to fetch position for ${p}:`, e);
          return null;
        }
      }),
    );

    return results.filter(
      (r): r is { protocol: LendingProtocol; position: PositionInfo } =>
        r !== null,
    );
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
          console.warn(`[DefiDashSDK] Failed to fetch portfolio for ${p}:`, e);
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

  /**
   * Get combined leverage info for an asset across all protocols.
   *
   * Returns risk parameters, APY data, and current price for each protocol.
   * Useful for comparing leverage opportunities across protocols.
   *
   * @param asset - Asset symbol (e.g., 'SUI', 'LBTC') or full coin type
   * @returns Array of leverage info for each protocol (excludes failed fetches)
   *
   * @throws {SDKNotInitializedError} If SDK not initialized
   *
   * @example
   * ```typescript
   * const infos = await sdk.getAssetLeverageInfo('SUI');
   *
   * for (const info of infos) {
   *   console.log(`${info.protocol}:`);
   *   console.log(`  Max Multiplier: ${info.riskParams.maxMultiplier.toFixed(2)}x`);
   *   console.log(`  Supply APY: ${(info.apy.totalSupplyApy * 100).toFixed(2)}%`);
   *   console.log(`  Borrow APY: ${(info.apy.borrowApy * 100).toFixed(2)}%`);
   * }
   * ```
   */
  async getAssetLeverageInfo(asset: string): Promise<AssetLeverageInfo[]> {
    this.ensureInitialized();

    const coinType = this.resolveCoinType(asset);
    const symbol = coinType.split('::').pop() ?? asset;

    // Fetch price once
    const priceUsd = await getTokenPrice(coinType);

    const allProtocols = [
      LendingProtocol.Suilend,
      LendingProtocol.Navi,
      LendingProtocol.Scallop,
    ];

    const results = await Promise.all(
      allProtocols.map(async (p): Promise<AssetLeverageInfo | null> => {
        try {
          const adapter = this.getProtocol(p);
          const [riskParams, apy] = await Promise.all([
            adapter.getAssetRiskParams(coinType),
            adapter.getAssetApy(coinType),
          ]);

          return {
            protocol: p,
            coinType,
            symbol,
            riskParams,
            apy,
            priceUsd,
          };
        } catch (e) {
          console.warn(
            `[DefiDashSDK] Failed to fetch leverage info for ${asset} on ${p}:`,
            e,
          );
          return null;
        }
      }),
    );

    return results.filter((r): r is AssetLeverageInfo => r !== null);
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
  // Execution Methods
  // ============================================================================

  /**
   * Dry run a transaction with gas optimization
   *
   * Simulates the transaction and returns estimated gas usage.
   * Does NOT execute the transaction on-chain.
   *
   * @param tx - Built transaction to simulate
   * @returns Strategy result with gas estimate
   *
   * @example
   * ```typescript
   * const tx = new Transaction();
   * tx.setSender(address);
   * await sdk.buildLeverageTransaction(tx, params);
   * const result = await sdk.dryRun(tx);
   * console.log(`Estimated gas: ${result.gasUsed}`);
   * ```
   */
  async dryRun(tx: Transaction): Promise<StrategyResult> {
    return dryRunTransaction(this.suiClient, tx);
  }

  /**
   * Execute a transaction with gas optimization (Node.js only)
   *
   * Flow:
   * 1. Dryrun with small fixed budget to get actual gas usage
   * 2. Calculate optimized budget (actual + 20% buffer)
   * 3. Check user has enough balance
   * 4. Execute with optimized budget
   *
   * @param tx - Built transaction to execute
   * @returns Strategy result with transaction digest and gas used
   *
   * @throws {KeypairRequiredError} If keypair not provided
   *
   * @example
   * ```typescript
   * const tx = new Transaction();
   * tx.setSender(address);
   * await sdk.buildLeverageTransaction(tx, params);
   * const result = await sdk.execute(tx);
   * console.log(`TX: ${result.txDigest}`);
   * ```
   */
  async execute(tx: Transaction): Promise<StrategyResult> {
    if (!this.keypair) {
      throw new KeypairRequiredError();
    }
    return executeTransaction(
      this.suiClient,
      this.keypair,
      this.userAddress,
      tx,
    );
  }
}
