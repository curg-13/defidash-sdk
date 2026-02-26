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
  AssetRiskParams,
  AssetApy,
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

  /**
   * Get asset risk parameters for leverage calculations
   *
   * Navi uses:
   * - ltv: Loan-to-Value ratio (RAY format, 10^27)
   * - liquidation_threshold: Liquidation threshold from pool config
   * - liquidation_bonus: Liquidation bonus from pool config
   */
  async getAssetRiskParams(coinType: string): Promise<AssetRiskParams> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);

    if (!pool) {
      // Fallback to conservative defaults
      return {
        ltv: 0.5,
        liquidationThreshold: 0.6,
        liquidationBonus: 0.05,
        maxMultiplier: 2.0,
      };
    }

    // Navi stores ltv as a string/number that may be in RAY format (10^27) or percentage
    // Common values: 650000000000000000000000000 (65% in RAY) or 0.65 or 65
    let ltv = 0.5;
    if (pool.ltv) {
      const ltvValue = parseFloat(pool.ltv.toString());
      // If value is very large (RAY format: 10^27), normalize
      if (ltvValue > 1e20) {
        ltv = ltvValue / 1e27;
      } else if (ltvValue > 1) {
        // Percentage format (e.g., 65 = 65%)
        ltv = ltvValue / 100;
      } else {
        // Already 0-1 format
        ltv = ltvValue;
      }
    }

    // Parse liquidation threshold similarly
    let liquidationThreshold = 0.7;
    if (pool.liquidationThreshold) {
      const thresholdValue = parseFloat(pool.liquidationThreshold.toString());
      if (thresholdValue > 1e20) {
        liquidationThreshold = thresholdValue / 1e27;
      } else if (thresholdValue > 1) {
        liquidationThreshold = thresholdValue / 100;
      } else {
        liquidationThreshold = thresholdValue;
      }
    }

    // Parse liquidation bonus
    let liquidationBonus = 0.05;
    if (pool.liquidationBonus) {
      const bonusValue = parseFloat(pool.liquidationBonus.toString());
      if (bonusValue > 1e20) {
        liquidationBonus = bonusValue / 1e27;
      } else if (bonusValue > 1) {
        liquidationBonus = bonusValue / 100;
      } else {
        liquidationBonus = bonusValue;
      }
    }

    // Calculate max multiplier: 1 / (1 - ltv)
    const maxMultiplier = ltv > 0 && ltv < 1 ? 1 / (1 - ltv) : 1;

    return {
      ltv,
      liquidationThreshold,
      liquidationBonus,
      maxMultiplier,
    };
  }

  /**
   * Get current supply/borrow APY for an asset.
   *
   * Navi's Pool object (from getPools) already contains:
   * - currentBorrowRate: raw per-second borrow rate
   * - currentSupplyRate: raw per-second supply rate
   * - supplyIncentiveApyInfo.apy / borrowIncentiveApyInfo.apy: incentive APY (as a string percent)
   *
   * We convert raw per-second rates to per-year APR then add incentive APY.
   */
  async getAssetApy(coinType: string): Promise<AssetApy> {
    this.ensureInitialized();

    const pool = this.getPool(coinType);
    if (!pool) {
      throw new Error(
        `Navi: pool not found for ${normalizeCoinType(coinType)}`,
      );
    }

    // Navi's Pool (from getPools) already exposes pre-computed APY info:
    //   supplyIncentiveApyInfo.apy   = effective supply APY (% string, e.g. "2.96")
    //   supplyIncentiveApyInfo.vaultApr = base supply APR before incentives
    //   borrowIncentiveApyInfo.vaultApr = gross borrow cost (% string)
    //   borrowIncentiveApyInfo.apy    = net borrow APY after borrow incentives
    //
    // We use vaultApr as the base supply APY and borrowIncentiveApyInfo.vaultApr
    // as the borrow APY (gross cost to borrower).
    // Reward APY = supplyIncentiveApyInfo.apy - supplyIncentiveApyInfo.vaultApr
    // (difference attributable to staking yield, vault rewards, etc.)

    const supplyInfo = pool.supplyIncentiveApyInfo ?? {};
    const borrowInfo = pool.borrowIncentiveApyInfo ?? {};

    // Base supply APR (e.g., "2.96" → 0.0296)
    const baseSupplyApr = parseFloat(supplyInfo.vaultApr ?? "0") / 100;
    // Total effective supply APY including staking/vault rewards
    const totalSupplyApy = parseFloat(supplyInfo.apy ?? "0") / 100;
    // Extra reward beyond base (staking yield etc.)
    const rewardApy = Math.max(0, totalSupplyApy - baseSupplyApr);

    // Gross borrow APR (what borrowers pay before incentives)
    const grossBorrowApr = parseFloat(borrowInfo.vaultApr ?? "0") / 100;
    // Net effective borrow cost after borrow incentive rebates
    // borrowInfo.apy = grossBorrowApr - boostedApr (rebate from NAVX/reward tokens)
    const netBorrowApy =
      parseFloat(borrowInfo.apy ?? borrowInfo.vaultApr ?? "0") / 100;
    const borrowRewardApy = Math.max(0, grossBorrowApr - netBorrowApy);

    return {
      supplyApy: baseSupplyApr,
      rewardApy,
      totalSupplyApy,
      borrowApy: netBorrowApy,
      borrowRewardApy,
    };
  }
}
