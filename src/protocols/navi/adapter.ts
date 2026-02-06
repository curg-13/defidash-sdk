/**
 * DeFi Dash SDK - Navi Protocol Adapter
 *
 * Implements ILendingProtocol for Navi
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import {
  depositCoinPTB,
  withdrawCoinPTB,
  borrowCoinPTB,
  repayCoinPTB,
  getPools,
  getLendingState,
  updateOraclePricesPTB,
  getPriceFeeds,
  getHealthFactor,
} from "@naviprotocol/lending";
import {
  ILendingProtocol,
  PositionInfo,
  AssetPosition,
  USDC_COIN_TYPE,
  AccountPortfolio,
  LendingProtocol,
  Position,
} from "../../types";
import { normalizeCoinType } from "../../utils";
import { getReserveByCoinType } from "../suilend/constants";
import { getTokenPrice } from "@7kprotocol/sdk-ts";

// Navi SDK returns balances with 9 decimal precision internally
const NAVI_BALANCE_DECIMALS = 9;

/**
 * Navi lending protocol adapter
 */
export class NaviAdapter implements ILendingProtocol {
  readonly name = "navi";
  readonly consumesRepaymentCoin = true; // Navi's repayCoinPTB consumes entire coin
  private suiClient!: SuiClient;
  private pools: any[] = [];
  private priceFeeds: any[] = [];
  private initialized = false;

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;

    // Fetch pools
    const poolsResult = await getPools({ env: "prod" });
    this.pools = Array.isArray(poolsResult)
      ? poolsResult
      : Object.values(poolsResult);

    // Fetch price feeds
    this.priceFeeds = await getPriceFeeds({ env: "prod" });

    this.initialized = true;
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error("NaviAdapter not initialized. Call initialize() first.");
    }
  }

  private getPool(coinType: string) {
    const normalized = normalizeCoinType(coinType);
    return this.pools.find((p) => {
      const poolCoinType = normalizeCoinType(p.coinType ?? p.suiCoinType ?? "");
      return poolCoinType === normalized;
    });
  }

  private getPriceFeed(coinType: string) {
    const normalized = normalizeCoinType(coinType);
    return this.priceFeeds.find(
      (f: any) => normalizeCoinType(f.coinType) === normalized,
    );
  }

  async getPosition(userAddress: string): Promise<PositionInfo | null> {
    this.ensureInitialized();

    const lendingState = await getLendingState(userAddress, { env: "prod" });
    if (lendingState.length === 0) return null;

    const activePositions = lendingState.filter(
      (p) => BigInt(p.supplyBalance) > 0 || BigInt(p.borrowBalance) > 0,
    );

    if (activePositions.length === 0) return null;

    // Find supply position
    let collateral: AssetPosition | null = null;
    let debt: AssetPosition | null = null;

    for (const pos of activePositions) {
      const poolCoinType = normalizeCoinType(pos.pool.coinType);
      const reserve = getReserveByCoinType(poolCoinType);
      const decimals = reserve?.decimals || 9;
      const symbol = reserve?.symbol || poolCoinType.split("::").pop() || "???";

      if (BigInt(pos.supplyBalance) > 0) {
        const amount = BigInt(pos.supplyBalance);
        const price = await getTokenPrice(poolCoinType);
        collateral = {
          amount,
          symbol,
          coinType: poolCoinType,
          decimals: NAVI_BALANCE_DECIMALS, // Navi uses 9 decimals internally
          valueUsd:
            (Number(amount) / Math.pow(10, NAVI_BALANCE_DECIMALS)) * price,
        };
      }

      if (BigInt(pos.borrowBalance) > 0) {
        const rawAmount = BigInt(pos.borrowBalance);
        // Convert from Navi's 9 decimal precision to native decimals
        const amount =
          rawAmount / BigInt(10 ** (NAVI_BALANCE_DECIMALS - decimals));
        const price = await getTokenPrice(poolCoinType);
        debt = {
          amount,
          symbol,
          coinType: poolCoinType,
          decimals,
          valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
        };
      }
    }

    if (!collateral) return null;

    const netValueUsd = collateral.valueUsd - (debt?.valueUsd || 0);

    return {
      collateral,
      debt: debt || {
        amount: 0n,
        symbol: "USDC",
        coinType: normalizeCoinType(USDC_COIN_TYPE),
        decimals: 6,
        valueUsd: 0,
      },
      netValueUsd,
    };
  }

  async deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(`Pool not found for ${coinType}`);
    }

    // Navi's depositCoinPTB expects the coin directly
    await depositCoinPTB(tx as any, pool, coin, {
      env: "prod",
    });
  }

  async withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(`Pool not found for ${coinType}`);
    }

    const withdrawnCoin = await withdrawCoinPTB(
      tx as any,
      pool,
      Number(amount),
      { env: "prod" },
    );

    return withdrawnCoin;
  }

  async borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
    skipOracle = false,
  ): Promise<any> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(`Pool not found for ${coinType}`);
    }

    const borrowedCoin = await borrowCoinPTB(tx as any, pool, Number(amount), {
      env: "prod",
    });

    return borrowedCoin;
  }

  async repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(`Pool not found for ${coinType}`);
    }

    await repayCoinPTB(tx as any, pool, coin, {
      env: "prod",
    });
  }

  async refreshOracles(
    tx: Transaction,
    coinTypes: string[],
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const feedsToUpdate = coinTypes
      .map((ct) => this.getPriceFeed(ct))
      .filter(Boolean);

    if (feedsToUpdate.length > 0) {
      await updateOraclePricesPTB(tx as any, feedsToUpdate, {
        env: "prod",
        updatePythPriceFeeds: true,
      });
    }
  }

  /**
   * Get aggregated portfolio
   */
  async getAccountPortfolio(address: string): Promise<AccountPortfolio> {
    this.ensureInitialized();

    const [lendingState, healthFactor] = await Promise.all([
      getLendingState(address, { env: "prod" }),
      getHealthFactor(address, { env: "prod" }),
    ]);

    const positions: Position[] = [];
    let totalCollateralUsd = 0;
    let totalDebtUsd = 0;
    let borrowLimitUsd = 0;
    let liquidationThresholdUsd = 0;

    for (const state of lendingState as any[]) {
      const coinType = normalizeCoinType(
        state.coinType ?? state.pool?.coinType ?? "",
      );
      const reserve = getReserveByCoinType(coinType);
      const symbol = reserve?.symbol || "UNKNOWN";
      const price = parseFloat(
        state.pool?.oracle?.price ?? state.pool?.price ?? "0",
      );

      const supplyRaw = BigInt(state.supplyBalance ?? 0);
      const borrowRaw = BigInt(state.borrowBalance ?? 0);

      // Return APY as decimal (e.g., 0.03 for 3%) to match Suilend format
      // Navi returns APY in percentage (e.g., 3.161 for 3.161%)
      // Convert to decimal to match Suilend format
      const getApy = (raw: any) => {
        const val = parseFloat(raw ?? "0");
        return val / 100;
      };

      if (supplyRaw > 0) {
        // Navi internal balances are 9 decimals
        const amount = Number(supplyRaw) / Math.pow(10, NAVI_BALANCE_DECIMALS);
        const valueUsd = amount * price;
        totalCollateralUsd += valueUsd;

        // Get LTV and liquidation threshold from pool
        const liqThreshold = parseFloat(
          state.pool?.liquidationFactor?.threshold ?? "0.8",
        );
        const ltv = liqThreshold - 0.05; // Safety margin, same as getMarkets

        borrowLimitUsd += valueUsd * ltv;
        liquidationThresholdUsd += valueUsd * liqThreshold;

        const supplyApy = getApy(
          state.pool?.supplyApy ?? state.pool?.supplyIncentiveApyInfo?.apy,
        );

        positions.push({
          protocol: LendingProtocol.Navi,
          symbol,
          coinType,
          side: "supply",
          amount,
          valueUsd,
          apy: supplyApy,
        });
      }

      if (borrowRaw > 0) {
        const amount = Number(borrowRaw) / Math.pow(10, NAVI_BALANCE_DECIMALS);
        const valueUsd = amount * price;
        totalDebtUsd += valueUsd;

        const borrowApy = getApy(
          state.pool?.borrowApy ?? state.pool?.borrowIncentiveApyInfo?.apy,
        );

        positions.push({
          protocol: LendingProtocol.Navi,
          symbol,
          coinType,
          side: "borrow",
          amount,
          valueUsd,
          apy: borrowApy,
        });
      }
    }

    // Calculate net APY and annual earnings
    const netValueUsd = totalCollateralUsd - totalDebtUsd;
    let weightedSupplyApy = 0;
    let weightedBorrowApy = 0;

    for (const pos of positions) {
      if (pos.side === "supply" && totalCollateralUsd > 0) {
        weightedSupplyApy += (pos.valueUsd / totalCollateralUsd) * pos.apy;
      } else if (pos.side === "borrow" && totalDebtUsd > 0) {
        weightedBorrowApy += (pos.valueUsd / totalDebtUsd) * pos.apy;
      }
    }

    // Net APY on equity = (supply earnings - borrow costs) / net value
    const supplyEarnings = totalCollateralUsd * weightedSupplyApy;
    const borrowCosts = totalDebtUsd * weightedBorrowApy;
    const netApy =
      netValueUsd > 0 ? (supplyEarnings - borrowCosts) / netValueUsd : 0;
    const totalAnnualNetEarningsUsd = supplyEarnings - borrowCosts;

    return {
      protocol: LendingProtocol.Navi,
      address,
      healthFactor: parseFloat(healthFactor.toString()),
      netValueUsd,
      totalCollateralUsd,
      totalDepositedUsd: totalCollateralUsd,
      totalDebtUsd,
      weightedBorrowsUsd: totalDebtUsd, // Navi uses 1:1 weight for borrows
      borrowLimitUsd,
      liquidationThresholdUsd,
      positions,
      netApy,
      totalAnnualNetEarningsUsd,
    };
  }
}
