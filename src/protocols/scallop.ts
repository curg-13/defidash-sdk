/**
 * DeFi Dash SDK - Scallop Protocol Adapter
 *
 * Implements ILendingProtocol for Scallop
 *
 * IMPORTANT: This adapter uses direct moveCall on the provided Transaction
 * to ensure PTB compatibility with flash loans and swaps.
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { Scallop, ScallopQuery } from "@scallop-io/sui-scallop-sdk";
import {
  ILendingProtocol,
  PositionInfo,
  AssetPosition,
  USDC_COIN_TYPE,
  AccountPortfolio,
  LendingProtocol,
  Position,
} from "../types";
import { normalizeCoinType } from "../utils";
import { getReserveByCoinType } from "../lib/suilend/const";
import { getTokenPrice } from "@7kprotocol/sdk-ts";

/**
 * Scallop Core IDs for direct moveCall
 */
const SCALLOP_CORE = {
  protocolPkg:
    "0xd384ded6b9e7f4d2c4c9007b0291ef88fbfed8e709bce83d2da69de2d79d013d",
  version: "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7",
  market: "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9",
  coinDecimalsRegistry:
    "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668",
  xOracle: "0x93d5bf0936b71eb27255941e532fac33b5a5c7759e377b4923af0a1359ad494f",
};

/**
 * Coin type mappings for Scallop
 */
const COIN_TYPE_MAP: Record<string, string> = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI":
    "sui",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    "usdc",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN":
    "wusdc",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN":
    "wusdt",
  "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN":
    "weth",
  "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN":
    "wbtc",
  "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS":
    "cetus",
  "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI":
    "afsui",
  "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI":
    "hasui",
  "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT":
    "vsui",
  "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA":
    "sca",
  "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP":
    "deep",
  "0x76cb819b01abed502bee8a702b4c2d547532c12f25001c9dea795a5e631c26f1::fud::FUD":
    "fud",
};

/**
 * Scallop lending protocol adapter
 */
export class ScallopAdapter implements ILendingProtocol {
  readonly name = "scallop";
  readonly consumesRepaymentCoin = false;

  private scallop!: Scallop;
  private query!: ScallopQuery;
  private suiClient!: SuiClient;
  private initialized = false;

  private coinTypeToNameMap: Record<string, string> = {};
  private coinNameToTypeMap: Record<string, string> = {};

  // Track pending obligation created in current transaction (for first leverage)
  private pendingObligation: any = null;
  private pendingObligationKey: any = null;
  private pendingHotPotato: any = null;
  private pendingUserAddress: string | null = null;

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;

    // Initialize Scallop SDK for queries only
    this.scallop = new Scallop({ networkType: "mainnet" });
    await this.scallop.init();
    this.query = await this.scallop.createScallopQuery();

    // Build coin mappings
    for (const [coinType, coinName] of Object.entries(COIN_TYPE_MAP)) {
      const normalized = normalizeCoinType(coinType);
      this.coinTypeToNameMap[normalized] = coinName;
      this.coinNameToTypeMap[coinName] = normalized;
    }

    this.initialized = true;
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error(
        "ScallopAdapter not initialized. Call initialize() first.",
      );
    }
  }

  private getCoinName(coinType: string): string {
    const normalized = normalizeCoinType(coinType);
    const name = this.coinTypeToNameMap[normalized];
    if (!name) {
      throw new Error(`Unknown coin type for Scallop: ${coinType}`);
    }
    return name;
  }

  private getCoinType(coinName: string): string {
    const coinType = this.coinNameToTypeMap[coinName.toLowerCase()];
    if (!coinType) {
      throw new Error(`Unknown coin name for Scallop: ${coinName}`);
    }
    return coinType;
  }

  // ============================================================================
  // Query Methods (unchanged - use Scallop SDK)
  // ============================================================================

  async getPosition(userAddress: string): Promise<PositionInfo | null> {
    this.ensureInitialized();

    const obligations = await this.query.getObligations(userAddress);
    if (obligations.length === 0) return null;

    const obligation = await this.query.queryObligation(obligations[0].id);
    if (!obligation) return null;

    let collateral: AssetPosition | null = null;
    let debt: AssetPosition | null = null;

    const collaterals = (obligation as any).collaterals || [];
    const debts = (obligation as any).debts || [];

    if (collaterals.length > 0) {
      const col = collaterals[0];
      const coinType = normalizeCoinType(col.coinType || col.type || "");
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 9;
      const amount = BigInt(col.amount || col.depositAmount || 0);
      const price = await getTokenPrice(coinType);

      collateral = {
        amount,
        symbol: reserve?.symbol || this.getCoinName(coinType).toUpperCase(),
        coinType,
        decimals,
        valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
      };
    }

    if (debts.length > 0) {
      const d = debts[0];
      const coinType = normalizeCoinType(d.coinType || d.type || "");
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 6;
      const amount = BigInt(d.amount || d.borrowAmount || 0);
      const price = await getTokenPrice(coinType);

      debt = {
        amount,
        symbol: reserve?.symbol || "USDC",
        coinType,
        decimals,
        valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
      };
    }

    if (!collateral) return null;

    return {
      collateral,
      debt: debt || {
        amount: 0n,
        symbol: "USDC",
        coinType: USDC_COIN_TYPE,
        decimals: 6,
        valueUsd: 0,
      },
      netValueUsd: collateral.valueUsd - (debt?.valueUsd || 0),
    };
  }

  // ============================================================================
  // Transaction Methods (DIRECT moveCall - no separate context)
  // ============================================================================

  /**
   * Open a new obligation
   */
  private openObligation(tx: Transaction): [any, any, any] {
    const result = tx.moveCall({
      target: `${SCALLOP_CORE.protocolPkg}::open_obligation::open_obligation`,
      arguments: [tx.object(SCALLOP_CORE.version)],
    });
    return [result[0], result[1], result[2]];
  }

  /**
   * Return obligation (consume hot potato)
   */
  private returnObligation(
    tx: Transaction,
    obligation: any,
    hotPotato: any,
  ): void {
    tx.moveCall({
      target: `${SCALLOP_CORE.protocolPkg}::open_obligation::return_obligation`,
      arguments: [tx.object(SCALLOP_CORE.version), obligation, hotPotato],
    });
  }

  /**
   * Add collateral to obligation
   */
  private addCollateral(
    tx: Transaction,
    obligation: any,
    coin: any,
    coinType: string,
  ): void {
    tx.moveCall({
      target: `${SCALLOP_CORE.protocolPkg}::deposit_collateral::deposit_collateral`,
      typeArguments: [coinType],
      arguments: [
        tx.object(SCALLOP_CORE.version),
        obligation,
        tx.object(SCALLOP_CORE.market),
        coin,
      ],
    });
  }

  /**
   * Borrow from obligation
   */
  private borrowFromObligation(
    tx: Transaction,
    obligation: any,
    obligationKey: any,
    amount: bigint,
    coinType: string,
  ): any {
    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: "1",
    });

    const result = tx.moveCall({
      target: `${SCALLOP_CORE.protocolPkg}::borrow::borrow`,
      typeArguments: [coinType],
      arguments: [
        tx.object(SCALLOP_CORE.version),
        obligation,
        obligationKey,
        tx.object(SCALLOP_CORE.market),
        tx.object(SCALLOP_CORE.coinDecimalsRegistry),
        tx.pure.u64(amount),
        tx.object(SCALLOP_CORE.xOracle),
        clockRef,
      ],
    });

    return result[0];
  }

  /**
   * Repay debt
   */
  private repayDebt(
    tx: Transaction,
    obligation: any,
    coin: any,
    coinType: string,
  ): void {
    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: "1",
    });

    tx.moveCall({
      target: `${SCALLOP_CORE.protocolPkg}::repay::repay`,
      typeArguments: [coinType],
      arguments: [
        tx.object(SCALLOP_CORE.version),
        obligation,
        tx.object(SCALLOP_CORE.market),
        coin,
        clockRef,
      ],
    });
  }

  // ============================================================================
  // ILendingProtocol Implementation
  // ============================================================================

  async deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const obligations = await this.query.getObligations(userAddress);

    if (obligations.length > 0) {
      // Use existing obligation
      const obligationId = obligations[0].id;
      this.addCollateral(tx, tx.object(obligationId), coin, normalized);
    } else {
      // Create new obligation - DO NOT return it yet!
      // We need to keep the obligation/key references valid for the borrow call
      // that happens later in the same transaction (leverage flow)
      const [obligation, obligationKey, hotPotato] = this.openObligation(tx);
      this.addCollateral(tx, obligation, coin, normalized);

      // Store references for borrow in same transaction
      // Note: We delay returnObligation until AFTER borrow is called
      this.pendingObligation = obligation;
      this.pendingObligationKey = obligationKey;
      this.pendingHotPotato = hotPotato;
      this.pendingUserAddress = userAddress;
    }
  }

  async withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const obligations = await this.query.getObligations(userAddress);

    if (obligations.length === 0) {
      throw new Error("No obligation found for withdrawal");
    }

    const obligationId = obligations[0].id;
    const obligationKeyId = obligations[0].keyId;

    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: "1",
    });

    const result = tx.moveCall({
      target: `${SCALLOP_CORE.protocolPkg}::withdraw_collateral::withdraw_collateral`,
      typeArguments: [normalized],
      arguments: [
        tx.object(SCALLOP_CORE.version),
        tx.object(obligationId),
        tx.object(obligationKeyId),
        tx.object(SCALLOP_CORE.market),
        tx.object(SCALLOP_CORE.coinDecimalsRegistry),
        tx.pure.u64(BigInt(amount)),
        tx.object(SCALLOP_CORE.xOracle),
        clockRef,
      ],
    });

    return result[0];
  }

  async borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
    skipOracle = false,
  ): Promise<any> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const obligations = await this.query.getObligations(userAddress);

    // Check if we have a pending obligation from deposit in same transaction
    if (
      obligations.length === 0 &&
      this.pendingObligation &&
      this.pendingObligationKey &&
      this.pendingHotPotato
    ) {
      // Use pending obligation created earlier in this transaction
      const result = this.borrowFromObligation(
        tx,
        this.pendingObligation,
        this.pendingObligationKey,
        BigInt(amount),
        normalized,
      );

      // NOW finalize the obligation (after borrow, not after deposit!)
      this.returnObligation(tx, this.pendingObligation, this.pendingHotPotato);
      tx.transferObjects([this.pendingObligationKey], this.pendingUserAddress!);

      // Clear pending state after use
      this.pendingObligation = null;
      this.pendingObligationKey = null;
      this.pendingHotPotato = null;
      this.pendingUserAddress = null;

      return result;
    }

    if (obligations.length === 0) {
      throw new Error("No obligation found for borrowing");
    }

    const obligationId = obligations[0].id;
    const obligationKeyId = obligations[0].keyId;

    return this.borrowFromObligation(
      tx,
      tx.object(obligationId),
      tx.object(obligationKeyId),
      BigInt(amount),
      normalized,
    );
  }

  async repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const obligations = await this.query.getObligations(userAddress);

    if (obligations.length === 0) {
      throw new Error("No obligation found for repayment");
    }

    const obligationId = obligations[0].id;
    this.repayDebt(tx, tx.object(obligationId), coin, normalized);
  }

  async refreshOracles(
    tx: Transaction,
    coinTypes: string[],
    userAddress: string,
  ): Promise<void> {
    // Scallop oracle refresh is embedded in borrow/withdraw calls via xOracle
    // No separate refresh needed for basic operations
  }

  async getAccountPortfolio(address: string): Promise<AccountPortfolio> {
    this.ensureInitialized();

    const emptyPortfolio: AccountPortfolio = {
      protocol: LendingProtocol.Scallop,
      address,
      healthFactor: Infinity,
      netValueUsd: 0,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      positions: [],
    };

    const obligations = await this.query.getObligations(address);
    if (obligations.length === 0) return emptyPortfolio;

    const obligation = await this.query.queryObligation(obligations[0].id);
    if (!obligation) return emptyPortfolio;

    const positions: Position[] = [];
    let totalCollateralUsd = 0;
    let totalDebtUsd = 0;

    const oblData = obligation as any;
    const collaterals = oblData.collaterals || [];
    const debts = oblData.debts || [];

    for (const col of collaterals) {
      const coinType = normalizeCoinType(col.coinType || col.type || "");
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 9;
      const amount =
        Number(col.amount || col.depositAmount || 0) / Math.pow(10, decimals);
      const price = await getTokenPrice(coinType);
      const valueUsd = amount * price;

      totalCollateralUsd += valueUsd;
      positions.push({
        protocol: LendingProtocol.Scallop,
        coinType,
        symbol: reserve?.symbol || "UNKNOWN",
        side: "supply",
        amount,
        valueUsd,
        apy: 0,
      });
    }

    for (const d of debts) {
      const coinType = normalizeCoinType(d.coinType || d.type || "");
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 6;
      const amount =
        Number(d.amount || d.borrowAmount || 0) / Math.pow(10, decimals);
      const price = await getTokenPrice(coinType);
      const valueUsd = amount * price;

      totalDebtUsd += valueUsd;
      positions.push({
        protocol: LendingProtocol.Scallop,
        coinType,
        symbol: reserve?.symbol || "USDC",
        side: "borrow",
        amount,
        valueUsd,
        apy: 0,
      });
    }

    return {
      protocol: LendingProtocol.Scallop,
      address,
      healthFactor:
        totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : Infinity,
      netValueUsd: totalCollateralUsd - totalDebtUsd,
      totalCollateralUsd,
      totalDebtUsd,
      positions,
    };
  }
}
