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
} from "./types";

import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { SuilendAdapter } from "./protocols/suilend/adapter";
import { NaviAdapter } from "./protocols/navi/adapter";
import { ScallopAdapter } from "./protocols/scallop/adapter";
import { ScallopFlashLoanClient } from "./protocols/scallop/flash-loan";
import { formatUnits } from "./utils";
import {
  buildLeverageTransaction as buildLeverageTx,
  calculateLeveragePreview as calcPreview,
} from "./strategies/leverage";
import { buildDeleverageTransaction as buildDeleverageTx } from "./strategies/deleverage";
import { normalizeCoinType, parseUnits } from "./utils";
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
    if (!this._userAddress) {
      throw new Error("User address not set. Call initialize() first.");
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

    throw new Error(`Unknown asset symbol: ${asset}`);
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
      throw new Error(
        "Either depositAmount or depositValueUsd must be provided",
      );
    }
    if (params.depositAmount && params.depositValueUsd) {
      throw new Error(
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
      throw new Error("No position found to deleverage");
    }

    if (position.debt.amount === 0n) {
      throw new Error("No debt to repay. Use withdraw instead.");
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
   * Requires SDK to be initialized with keypair.
   * For browser usage, use buildLeverageTransaction instead.
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
   * Requires SDK to be initialized with keypair.
   * For browser usage, use buildDeleverageTransaction instead.
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
   * Get current lending position
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
   */
  async previewLeverage(params: {
    depositAsset: string;
    depositAmount?: string;
    depositValueUsd?: number;
    multiplier: number;
  }): Promise<LeveragePreview> {
    // Validate that exactly one is provided
    if (!params.depositAmount && !params.depositValueUsd) {
      throw new Error(
        "Either depositAmount or depositValueUsd must be provided",
      );
    }
    if (params.depositAmount && params.depositValueUsd) {
      throw new Error(
        "Cannot provide both depositAmount and depositValueUsd. Choose one.",
      );
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

  // Default gas budget for dryrun (0.1 SUI) - enough for complex operations like Scallop leverage
  private static readonly DRYRUN_GAS_BUDGET = 100_000_000n;

  /**
   * Calculate actual gas from dryrun result
   */
  private calculateActualGas(gasUsed: {
    computationCost: string;
    storageCost: string;
    storageRebate: string;
  }): bigint {
    const computationCost = BigInt(gasUsed.computationCost);
    const storageCost = BigInt(gasUsed.storageCost);
    const storageRebate = BigInt(gasUsed.storageRebate);
    return computationCost + storageCost - storageRebate;
  }

  /**
   * Dry run with gas optimization
   *
   * Uses small fixed budget for dryrun, returns actual gas estimation.
   */
  private async dryRunWithGasOptimization(
    tx: Transaction,
  ): Promise<StrategyResult> {
    // Use small fixed budget for dryrun simulation
    tx.setGasBudget(DefiDashSDK.DRYRUN_GAS_BUDGET);

    const result = await this.suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: this.suiClient }),
    });

    if (result.effects.status.status === "success") {
      const actualGas = this.calculateActualGas(result.effects.gasUsed);
      const optimizedBudget = (actualGas * 120n) / 100n; // +20% buffer

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
      throw new Error("Keypair required for execution");
    }

    // Step 1: Dryrun with small fixed budget
    tx.setGasBudget(DefiDashSDK.DRYRUN_GAS_BUDGET);

    const dryRunResult = await this.suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: this.suiClient }),
    });

    if (dryRunResult.effects.status.status !== "success") {
      return {
        success: false,
        error: `Dry run failed: ${dryRunResult.effects.status.error}`,
      };
    }

    // Step 2: Calculate optimized gas budget (actual + 20% buffer)
    const actualGas = this.calculateActualGas(dryRunResult.effects.gasUsed);
    const optimizedBudget = (actualGas * 120n) / 100n;

    // Step 3: Check if user has enough balance
    const balance = await this.suiClient.getBalance({
      owner: this.userAddress,
    });
    const userBalance = BigInt(balance.totalBalance);

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

    try {
      // Resolve coin type and amounts
      const coinType = this.resolveCoinType(params.depositAsset);
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 9;
      const symbol = coinType.split("::").pop()?.toUpperCase() || "SUI";
      const isSui = coinType.endsWith("::sui::SUI");

      // Get coin name for Scallop (e.g., "sui", "usdc")
      const coinName = this.getScallopCoinName(coinType);

      // Calculate deposit amount
      let depositAmountStr: string;
      if (params.depositValueUsd) {
        const price = await getTokenPrice(coinType);
        depositAmountStr = (params.depositValueUsd / price).toFixed(decimals);
      } else {
        depositAmountStr = params.depositAmount!;
      }
      const depositAmountRaw = parseUnits(depositAmountStr, decimals);
      const depositAmountHuman = parseFloat(depositAmountStr);

      // Calculate flash loan amount
      const depositPrice = await getTokenPrice(coinType);
      const initialEquityUsd = depositAmountHuman * depositPrice;
      const flashLoanUsd = initialEquityUsd * (params.multiplier - 1);
      const flashLoanUsdc = BigInt(Math.ceil(flashLoanUsd * 1e6 * 1.02));

      const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
      const repaymentAmount = flashLoanUsdc + flashLoanFee;
      const borrowFeeBuffer = 1.003;
      const borrowAmount = BigInt(
        Math.ceil(Number(repaymentAmount) * borrowFeeBuffer),
      );

      // Initialize Scallop SDK with secret key
      // Scallop SDK requires the original secret key string (not extracted from keypair)
      if (!this.options.secretKey) {
        return {
          success: false,
          error: "Scallop operations require secretKey in SDK options. Pass { secretKey: 'suiprivkey...' } to DefiDashSDK constructor.",
        };
      }

      const scallop = new Scallop({
        secretKey: this.options.secretKey,
        networkType: "mainnet",
      });
      await scallop.init();

      const builder = await scallop.createScallopBuilder();
      const client = await scallop.createScallopClient();
      const tx = builder.createTxBlock();
      tx.setSender(this.userAddress);

      // Check for existing obligation
      const existingObligations = await client.getObligations();
      const hasExistingObligation = existingObligations.length > 0;
      let existingObligationId: string | null = null;
      let existingObligationKeyId: string | null = null;
      let isCurrentlyLocked = false;

      if (hasExistingObligation) {
        existingObligationId = existingObligations[0].id;
        existingObligationKeyId = existingObligations[0].keyId;
        isCurrentlyLocked = existingObligations[0].locked;
      }

      // Get swap quote
      const swapQuotes = await this.swapClient.quote({
        amountIn: flashLoanUsdc.toString(),
        coinTypeIn: COIN_TYPES.USDC,
        coinTypeOut: coinType,
      });

      if (swapQuotes.length === 0) {
        return { success: false, error: `No swap quotes for USDC → ${symbol}` };
      }

      const bestQuote = swapQuotes.sort(
        (a, b) => Number(b.amountOut) - Number(a.amountOut),
      )[0];

      // Build transaction using Scallop SDK
      // Step 1: Flash loan USDC
      const [loanCoin, receipt] = await tx.borrowFlashLoan(
        Number(flashLoanUsdc),
        "usdc",
      );

      // Step 2: Swap USDC → deposit asset
      const swappedAsset = await this.swapClient.swap(
        {
          quote: bestQuote,
          signer: this.userAddress,
          coinIn: loanCoin,
          tx: tx.txBlock,
        },
        100,
      );

      // Step 3: Prepare deposit coin
      let depositCoin: any;
      if (isSui) {
        const [userDeposit] = tx.splitSUIFromGas([Number(depositAmountRaw)]);
        tx.mergeCoins(userDeposit, [swappedAsset]);
        depositCoin = userDeposit;
      } else {
        const userCoins = await this.suiClient.getCoins({
          owner: this.userAddress,
          coinType,
        });

        if (userCoins.data.length === 0) {
          return { success: false, error: `No ${symbol} coins in wallet` };
        }

        const primaryCoin = tx.txBlock.object(userCoins.data[0].coinObjectId);
        if (userCoins.data.length > 1) {
          const otherCoins = userCoins.data
            .slice(1)
            .map((c) => tx.txBlock.object(c.coinObjectId));
          tx.mergeCoins(primaryCoin, otherCoins);
        }

        const [userContribution] = tx.splitCoins(primaryCoin, [
          Number(depositAmountRaw),
        ]);
        tx.mergeCoins(userContribution, [swappedAsset]);
        depositCoin = userContribution;
      }

      // Step 4: Handle obligation
      let obligation: any;
      let obligationKey: any;
      let obligationHotPotato: any;
      let isNewObligation = false;

      if (hasExistingObligation && existingObligationId && existingObligationKeyId) {
        obligation = tx.txBlock.object(existingObligationId);
        obligationKey = tx.txBlock.object(existingObligationKeyId);

        if (isCurrentlyLocked) {
          tx.unstakeObligation(obligation, obligationKey);
        }

        tx.addCollateral(obligation, depositCoin, coinName);
      } else {
        [obligation, obligationKey, obligationHotPotato] = tx.openObligation();
        tx.addCollateral(obligation, depositCoin, coinName);
        isNewObligation = true;
      }

      // Step 5: Update oracles (critical for Scallop!)
      await tx.updateAssetPricesQuick([coinName, "usdc"]);

      // Step 6: Borrow USDC
      const borrowedUsdc = tx.borrow(
        obligation,
        obligationKey,
        Number(borrowAmount),
        "usdc",
      );

      // Step 7: Repay flash loan
      await tx.repayFlashLoan(borrowedUsdc, receipt, "usdc");

      // Step 8: Finalize
      if (isNewObligation) {
        tx.returnObligation(obligation, obligationHotPotato);
        tx.stakeObligation(obligation, obligationKey);
        tx.transferObjects([obligationKey], this.userAddress);
      } else {
        tx.stakeObligation(obligation, obligationKey);
      }

      // Execute
      if (params.dryRun) {
        tx.txBlock.setGasBudget(DefiDashSDK.DRYRUN_GAS_BUDGET);
        const dryRunResult = await this.suiClient.dryRunTransactionBlock({
          transactionBlock: await tx.txBlock.build({ client: this.suiClient }),
        });

        if (dryRunResult.effects.status.status === "success") {
          const actualGas = this.calculateActualGas(dryRunResult.effects.gasUsed);
          return { success: true, gasUsed: (actualGas * 120n) / 100n };
        }
        return {
          success: false,
          error: dryRunResult.effects.status.error || "Dry run failed",
        };
      }

      // For real execution, do dryrun first to optimize gas
      tx.txBlock.setGasBudget(DefiDashSDK.DRYRUN_GAS_BUDGET);
      const dryRunResult = await this.suiClient.dryRunTransactionBlock({
        transactionBlock: await tx.txBlock.build({ client: this.suiClient }),
      });

      if (dryRunResult.effects.status.status !== "success") {
        return {
          success: false,
          error: `Dry run failed: ${dryRunResult.effects.status.error}`,
        };
      }

      const actualGas = this.calculateActualGas(dryRunResult.effects.gasUsed);
      const optimizedBudget = (actualGas * 120n) / 100n;
      tx.txBlock.setGasBudget(optimizedBudget);

      const result = await builder.signAndSendTxBlock(tx);

      // Fetch transaction details to get actual gas used
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

  /**
   * Get Scallop coin name from coin type
   */
  private getScallopCoinName(coinType: string): string {
    const normalized = normalizeCoinType(coinType);
    const COIN_NAME_MAP: Record<string, string> = {
      "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI": "sui",
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": "usdc",
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN": "wusdc",
      "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN": "wusdt",
    };
    return COIN_NAME_MAP[normalized] || normalized.split("::").pop()?.toLowerCase() || "sui";
  }
}
