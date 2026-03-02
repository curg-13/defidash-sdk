/**
 * DeFi Dash SDK - Suilend Protocol Adapter
 *
 * Implements ILendingProtocol for Suilend
 */

import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { parseReserve } from "@suilend/sdk/parsers/reserve";
import { parseObligation } from "@suilend/sdk/parsers/obligation";
import { CoinMetadata } from "@mysten/sui/client";
import { normalizeStructTag } from "@mysten/sui/utils";
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
import { getReserveByCoinType } from "./constants";
import { getTokenPrice } from "@7kprotocol/sdk-ts";
import {
  calculatePortfolioMetrics,
  calculateRewardsEarned,
  calculateLiquidationPrice,
  calculateRewardApy,
} from "./calculators";
import {
  calculateDepositAprPercent,
  calculateBorrowAprPercent,
} from "@suilend/sdk/utils/simulate";
import BigNumber from "bignumber.js";

// Suilend uses WAD (10^18) for internal precision
const WAD = 10n ** 18n;

/**
 * Suilend lending protocol adapter
 */
export class SuilendAdapter implements ILendingProtocol {
  readonly name = "suilend";
  readonly consumesRepaymentCoin = false; // Suilend returns unused portion
  private client!: SuilendClient;
  private suiClient!: SuiClient;
  private initialized = false;

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;
    this.client = await SuilendClient.initialize(
      LENDING_MARKET_ID,
      LENDING_MARKET_TYPE,
      suiClient,
    );
    this.initialized = true;
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error(
        "SuilendAdapter not initialized. Call initialize() first.",
      );
    }
  }

  async getPosition(userAddress: string): Promise<PositionInfo | null> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) return null;

    const obligation = await SuilendClient.getObligation(
      caps[0].obligationId,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (!obligation) return null;

    const deposits = obligation.deposits || [];
    const borrows = obligation.borrows || [];

    if (deposits.length === 0 && borrows.length === 0) return null;

    // Build all supply positions
    const supplies: AssetPosition[] = await Promise.all(
      deposits.map(async (deposit: any) => {
        const coinType = normalizeCoinType(deposit.coinType.name);
        const reserve = getReserveByCoinType(coinType);
        const amount = BigInt(deposit.depositedCtokenAmount);
        const price = await getTokenPrice(coinType);
        const decimals = reserve?.decimals || 9;
        const valueUsd = (Number(amount) / Math.pow(10, decimals)) * price;
        return {
          amount,
          symbol: reserve?.symbol || "???",
          coinType,
          decimals,
          valueUsd,
        };
      }),
    );

    // Build all borrow positions
    const allBorrows: AssetPosition[] = await Promise.all(
      borrows.map(async (borrow: any) => {
        const coinType = normalizeCoinType(borrow.coinType.name);
        const reserve = getReserveByCoinType(coinType);
        const rawAmount = BigInt(borrow.borrowedAmount.value);
        const amount = rawAmount / WAD;
        const price = await getTokenPrice(coinType);
        const decimals = reserve?.decimals || 6;
        const valueUsd = (Number(amount) / Math.pow(10, decimals)) * price;
        return {
          amount,
          symbol: reserve?.symbol || "USDC",
          coinType,
          decimals,
          valueUsd,
        };
      }),
    );

    // Primary = largest by USD value
    const collateral = [...supplies].sort((a, b) => b.valueUsd - a.valueUsd)[0] ?? null;
    if (!collateral) return null;

    const debt = allBorrows.length > 0
      ? [...allBorrows].sort((a, b) => b.valueUsd - a.valueUsd)[0]
      : null;

    const totalSupplyUsd = supplies.reduce((s, p) => s + p.valueUsd, 0);
    const totalDebtUsd = allBorrows.reduce((s, p) => s + p.valueUsd, 0);

    return {
      collateral,
      debt: debt || {
        amount: 0n,
        symbol: "USDC",
        coinType: USDC_COIN_TYPE,
        decimals: 6,
        valueUsd: 0,
      },
      supplies,
      borrows: allBorrows,
      netValueUsd: totalSupplyUsd - totalDebtUsd,
    };
  }

  async deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    let obligationOwnerCap: any;
    let isNew = false;

    if (caps.length > 0) {
      obligationOwnerCap = caps[0].id;
    } else {
      // Create new obligation
      obligationOwnerCap = this.client.createObligation(tx);
      isNew = true;
    }

    this.client.deposit(coin, coinType, obligationOwnerCap, tx);

    if (isNew) {
      tx.transferObjects([obligationOwnerCap], userAddress);
    }
  }

  async withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) {
      throw new Error("No obligation found for withdrawal");
    }

    const cap = caps[0];
    const result = await this.client.withdraw(
      cap.id,
      cap.obligationId,
      coinType,
      amount,
      tx,
      false, // Skip refresh, assume already done
    );

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

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) {
      throw new Error("No obligation found for borrowing");
    }

    const cap = caps[0];
    const result = await this.client.borrow(
      cap.id,
      cap.obligationId,
      coinType,
      amount,
      tx,
      skipOracle,
    );

    return result[0];
  }

  async repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length === 0) {
      throw new Error("No obligation found for repayment");
    }

    this.client.repay(caps[0].obligationId, coinType, coin, tx);
  }

  async refreshOracles(
    tx: Transaction,
    coinTypes: string[],
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (caps.length > 0) {
      const obligation = await SuilendClient.getObligation(
        caps[0].obligationId,
        [LENDING_MARKET_TYPE],
        this.suiClient,
      );

      // Filter out coinTypes already in the obligation to avoid duplicate
      // Pyth VAA submissions. Suilend SDK's refreshAll uses a Map keyed by
      // reserveArrayIndex, but obligation entries use string keys while
      // findReserveArrayIndex returns BigInt — causing the same reserve to
      // appear twice and triggering dynamic_field::add abort.
      const existingCoinTypes = new Set<string>();
      (obligation?.deposits ?? []).forEach((d: any) =>
        existingCoinTypes.add(normalizeCoinType(d.coinType.name)),
      );
      (obligation?.borrows ?? []).forEach((b: any) =>
        existingCoinTypes.add(normalizeCoinType(b.coinType.name)),
      );

      const newCoinTypes = coinTypes.filter(
        (ct) => !existingCoinTypes.has(normalizeCoinType(ct)),
      );

      await this.client.refreshAll(
        tx,
        obligation,
        newCoinTypes.length > 0 ? newCoinTypes : undefined,
      );
    } else {
      await this.client.refreshAll(tx, undefined, coinTypes);
    }
  }

  private coinMetadataCache: Record<string, CoinMetadata> = {};

  async getAccountPortfolio(address: string): Promise<AccountPortfolio> {
    this.ensureInitialized();

    const caps = await SuilendClient.getObligationOwnerCaps(
      address,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    const emptyPortfolio: AccountPortfolio = {
      protocol: LendingProtocol.Suilend,
      address,
      healthFactor: Infinity,
      netValueUsd: 0,
      totalCollateralUsd: 0,
      totalDepositedUsd: 0,
      totalDebtUsd: 0,
      weightedBorrowsUsd: 0,
      borrowLimitUsd: 0,
      liquidationThresholdUsd: 0,
      positions: [],
      netApy: 0,
      totalAnnualNetEarningsUsd: 0,
    };

    if (caps.length === 0) {
      return emptyPortfolio;
    }

    const obligation = await SuilendClient.getObligation(
      caps[0].obligationId,
      [LENDING_MARKET_TYPE],
      this.suiClient,
    );

    if (!obligation) return emptyPortfolio;

    // Use reserves directly (already fetched by initialize)
    const refreshedReserves = this.client.lendingMarket.reserves;

    // Build Metadata Map (reusing logic specific to this adapter's cache)
    const allCoinTypes = new Set<string>();
    refreshedReserves.forEach((r) => {
      allCoinTypes.add(r.coinType.name);
      r.depositsPoolRewardManager.poolRewards.forEach((pr) => {
        if (pr) allCoinTypes.add(pr.coinType.name);
      });
      r.borrowsPoolRewardManager.poolRewards.forEach((pr) => {
        if (pr) allCoinTypes.add(pr.coinType.name);
      });
    });

    const uniqueCoinTypes = Array.from(allCoinTypes);
    await Promise.all(
      uniqueCoinTypes.map(async (ct) => {
        const normalized = normalizeStructTag(ct);
        if (!this.coinMetadataCache[normalized]) {
          try {
            const metadata = await this.suiClient.getCoinMetadata({
              coinType: ct,
            });
            if (metadata) {
              this.coinMetadataCache[normalized] = metadata;
            }
          } catch (e) {
            // ignore failed metadata fetch
          }
        }
      }),
    );

    // Create a map for parser with fallbacks
    const coinMetadataMap: Record<string, CoinMetadata> = {
      ...this.coinMetadataCache,
    };
    uniqueCoinTypes.forEach((ct) => {
      const normalized = normalizeStructTag(ct);
      if (!coinMetadataMap[normalized]) {
        coinMetadataMap[normalized] = {
          decimals: 9,
          name: ct,
          symbol: ct.split("::").pop() ?? "UNK",
          description: "",
          iconUrl: "",
          id: "",
        };
      }
    });

    const parsedReserveMap: Record<string, any> = {};
    refreshedReserves.forEach((r) => {
      const parsed = parseReserve(r, coinMetadataMap);
      parsedReserveMap[normalizeStructTag(parsed.coinType)] = parsed;
    });

    const parsedObligation = parseObligation(obligation, parsedReserveMap);

    // --- USE CALCULATORS ---
    const metrics = calculatePortfolioMetrics(
      parsedObligation,
      parsedReserveMap,
    );

    // Map to positions
    const positions: Position[] = [];

    // Deposits
    parsedObligation.deposits.forEach((d) => {
      const reserve = d.reserve;
      const earnings = calculateRewardsEarned(
        d.userRewardManager,
        reserve,
        true,
      );

      // Reward APY
      const totalDepositedUsd = new BigNumber(d.reserve.depositedAmountUsd);
      const rewardApyStats = calculateRewardApy(
        reserve.depositsPoolRewardManager,
        totalDepositedUsd,
        parsedReserveMap,
      );
      const interestApy = d.reserve.depositAprPercent.div(100).toNumber();

      // Liquidation Price
      const amountBig = new BigNumber(d.depositedAmount);
      const liqPriceBig = calculateLiquidationPrice(
        d.reserve.coinType,
        amountBig,
        Number(d.reserve.config.closeLtvPct) / 100,
        parsedObligation,
      );

      positions.push({
        protocol: LendingProtocol.Suilend,
        coinType: d.coinType,
        symbol: d.reserve.token.symbol,
        side: "supply",
        amount: d.depositedAmount.toNumber(),
        amountRaw: d.depositedAmount
          .times(Math.pow(10, d.reserve.mintDecimals))
          .toFixed(0),
        valueUsd: d.depositedAmountUsd.toNumber(),
        apy: interestApy + rewardApyStats.totalRewardApy / 100,
        rewardsApy: rewardApyStats.totalRewardApy / 100,
        rewards: earnings,
        estimatedLiquidationPrice: liqPriceBig
          ? liqPriceBig.toNumber()
          : undefined,
      });
    });

    // Borrows
    parsedObligation.borrows.forEach((b) => {
      const reserve = b.reserve;
      const earnings = calculateRewardsEarned(
        b.userRewardManager,
        reserve,
        false,
      );
      positions.push({
        protocol: LendingProtocol.Suilend,
        coinType: b.coinType,
        symbol: b.reserve.token.symbol,
        side: "borrow",
        amount: b.borrowedAmount.toNumber(),
        amountRaw: b.borrowedAmount
          .times(Math.pow(10, b.reserve.mintDecimals))
          .toFixed(0),
        valueUsd: b.borrowedAmountUsd.toNumber(),
        apy: b.reserve.borrowAprPercent.div(100).toNumber(),
        rewards: earnings,
      });
    });

    return {
      protocol: LendingProtocol.Suilend,
      address,
      healthFactor: metrics.healthFactor.toNumber(),
      netValueUsd: metrics.netValue.toNumber(),
      totalCollateralUsd: metrics.totalSupply.toNumber(),
      totalDepositedUsd: metrics.totalSupply.toNumber(),
      totalDebtUsd: metrics.totalBorrow.toNumber(),
      weightedBorrowsUsd: parsedObligation.weightedBorrowsUsd.toNumber(),
      borrowLimitUsd: metrics.borrowLimit.toNumber(),
      liquidationThresholdUsd: metrics.liquidationThreshold.toNumber(),
      positions,
      netApy: metrics.netApy.toNumber(),
      totalAnnualNetEarningsUsd: metrics.totalAnnualNetEarnings.toNumber(),
    };
  }

  /**
   * Get asset risk parameters for leverage calculations
   *
   * Suilend uses:
   * - openLtvPct: LTV for opening positions (0-100)
   * - closeLtvPct: LTV for liquidation threshold (0-100)
   * - liquidationBonusBps: Liquidation bonus in basis points
   */
  async getAssetRiskParams(coinType: string): Promise<AssetRiskParams> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);

    // Find the reserve for this coin type
    const reserve = this.client.lendingMarket.reserves.find(
      (r) => normalizeCoinType(r.coinType.name) === normalized,
    );

    if (!reserve) {
      // Fallback to conservative defaults
      return {
        ltv: 0.5,
        liquidationThreshold: 0.6,
        liquidationBonus: 0.05,
        maxMultiplier: 2.0,
      };
    }

    const config = reserve.config.element;
    if (!config) {
      return {
        ltv: 0.5,
        liquidationThreshold: 0.6,
        liquidationBonus: 0.05,
        maxMultiplier: 2.0,
      };
    }

    // openLtvPct is u8 (0-100), convert to 0-1
    const ltv = Number(config.openLtvPct) / 100;
    // closeLtvPct is the liquidation threshold
    const liquidationThreshold = Number(config.closeLtvPct) / 100;
    // liquidationBonusBps is in basis points
    const liquidationBonus = Number(config.liquidationBonusBps) / 10000;
    // maxMultiplier = 1 / (1 - ltv), with safety margin
    const maxMultiplier = ltv > 0 ? 1 / (1 - ltv) : 1;

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
   * Uses Suilend simulate utils directly on raw Reserve data so we don't need
   * a full coinMetadataMap (which parseReserve requires for reward tokens).
   *
   * WAD for Suilend reserve internal decimals = 10^18.
   */
  async getAssetApy(coinType: string): Promise<AssetApy> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const reserve = this.client.lendingMarket.reserves.find(
      (r) => normalizeCoinType(r.coinType.name) === normalized,
    );

    if (!reserve) {
      throw new Error(`Suilend: reserve not found for ${normalized}`);
    }

    // Use simulate utils directly — these only need the raw Reserve<string>
    const SUILEND_WAD = 10n ** 18n;
    const supplyAprPercent = calculateDepositAprPercent(reserve);
    const borrowAprPercent = calculateBorrowAprPercent(reserve);

    const supplyApy = supplyAprPercent.div(100).toNumber();
    const borrowApy = borrowAprPercent.div(100).toNumber();

    // Reward APY: estimate from active pool rewards.
    // Uses actual reward token price via getTokenPrice (7k) where possible.
    const mintDecimals = reserve.mintDecimals;
    const availableAmount = new BigNumber(
      reserve.availableAmount.toString(),
    ).div(10 ** mintDecimals);
    const borrowedAmount = new BigNumber(
      reserve.borrowedAmount.value.toString(),
    )
      .div(SUILEND_WAD)
      .div(10 ** mintDecimals);
    const totalDeposited = availableAmount.plus(borrowedAmount);
    const price = new BigNumber(reserve.price.value.toString()).div(
      SUILEND_WAD,
    );
    const totalDepositedUsd = totalDeposited.times(price);
    const totalBorrowedUsd = borrowedAmount.times(price);

    const nowMs = Date.now();
    const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

    // Helper: sum active rewards from a poolRewardManager
    // totalUsd: the pool size to use as APY denominator
    //   - supply rewards → totalDepositedUsd
    //   - borrow rewards → totalBorrowedUsd
    const sumRewardApy = async (
      poolRewards: typeof reserve.depositsPoolRewardManager.poolRewards,
      totalUsd: BigNumber,
    ): Promise<number> => {
      if (totalUsd.lte(0)) return 0;
      let apy = 0;
      for (const poolReward of poolRewards) {
        if (!poolReward) continue;
        const startMs = Number(poolReward.startTimeMs);
        const endMs = Number(poolReward.endTimeMs);
        if (endMs <= nowMs || startMs >= endMs) continue;
        const durationMs = endMs - startMs;

        // Raw on-chain integer; detect decimals from coinType
        // (assume 9 for SUI-ecosystem, 6 for stablecoins)
        const rewardCoinType: string | undefined =
          typeof (poolReward as any).coinType === "string"
            ? (poolReward as any).coinType
            : (poolReward as any).coinType?.name
              ? String((poolReward as any).coinType.name)
              : undefined;
        const rewardDecimals = rewardCoinType?.toLowerCase().includes("usdc")
          ? 6
          : 9;
        const totalRewards = new BigNumber(
          poolReward.totalRewards.toString(),
        ).div(10 ** rewardDecimals);
        const rewardPerYear = totalRewards.times(MS_PER_YEAR).div(durationMs);

        // Fetch real reward token price.
        // Suilend stores coinType.name without "0x" prefix — normalize before price lookup.
        // If price is unavailable, skip this reward to avoid wildly wrong APY
        // (e.g., using deposit asset price as proxy for DEEP → 3700% instead of 1.5%).
        let rewardPrice: BigNumber | null = null;
        if (rewardCoinType) {
          try {
            const normalizedReward = normalizeCoinType(rewardCoinType);
            const fetchedPrice = await getTokenPrice(normalizedReward);
            if (fetchedPrice > 0) {
              rewardPrice = new BigNumber(fetchedPrice);
            }
          } catch {
            // price unavailable — skip this reward
          }
        }
        if (!rewardPrice) continue;

        apy += rewardPerYear.times(rewardPrice).div(totalUsd).toNumber();
      }
      return apy;
    };

    const rewardApy = await sumRewardApy(
      reserve.depositsPoolRewardManager.poolRewards,
      totalDepositedUsd,
    );

    // Borrow rewards reduce the effective borrow cost.
    // Denominator = totalBorrowedUsd (not totalDepositedUsd) — covers borrow incentive value.
    const borrowRewardApy = await sumRewardApy(
      reserve.borrowsPoolRewardManager.poolRewards,
      totalBorrowedUsd,
    );

    return {
      supplyApy,
      rewardApy,
      totalSupplyApy: supplyApy + rewardApy,
      // Net borrow cost: gross APR minus borrow incentive rebates
      borrowApy: Math.max(0, borrowApy - borrowRewardApy),
      borrowRewardApy,
    };
  }
}
