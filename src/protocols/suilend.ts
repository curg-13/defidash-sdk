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
  USDC_COIN_TYPE,
  AccountPortfolio,
  LendingProtocol,
  Position,
} from "../types";
import { normalizeCoinType } from "../utils";
import { getReserveByCoinType } from "../lib/suilend/const";
import { getTokenPrice } from "@7kprotocol/sdk-ts";
import {
  calculatePortfolioMetrics,
  calculateRewardsEarned,
  calculateLiquidationPrice,
  calculateRewardApy,
} from "../lib/suilend/calculators";
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

    // Parse first deposit as collateral
    let collateral: AssetPosition | null = null;
    if (deposits.length > 0) {
      const deposit = deposits[0] as any;
      const coinType = normalizeCoinType(deposit.coinType.name);
      const reserve = getReserveByCoinType(coinType);
      const amount = BigInt(deposit.depositedCtokenAmount);
      const price = await getTokenPrice(coinType);
      const decimals = reserve?.decimals || 9;

      collateral = {
        amount,
        symbol: reserve?.symbol || "???",
        coinType,
        decimals,
        valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
      };
    }

    // Parse first borrow as debt
    let debt: AssetPosition | null = null;
    if (borrows.length > 0) {
      const borrow = borrows[0] as any;
      const coinType = normalizeCoinType(borrow.coinType.name);
      const reserve = getReserveByCoinType(coinType);
      const rawAmount = BigInt(borrow.borrowedAmount.value);
      const amount = rawAmount / WAD;
      const price = await getTokenPrice(coinType);
      const decimals = reserve?.decimals || 6;

      debt = {
        amount,
        symbol: reserve?.symbol || "USDC",
        coinType,
        decimals,
        valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
      };
    }

    if (!collateral) return null;

    const netValueUsd = collateral.valueUsd - (debt?.valueUsd || 0);

    return {
      collateral,
      debt: debt || {
        amount: 0n,
        symbol: "USDC",
        coinType: USDC_COIN_TYPE,
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
      await this.client.refreshAll(tx, obligation, coinTypes);
    } else {
      // For new obligations, just refresh reserves
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

    console.log(
      "SDK Available Reserves:",
      Object.values(parsedReserveMap).map((r: any) => r.token.symbol),
    );

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
}
