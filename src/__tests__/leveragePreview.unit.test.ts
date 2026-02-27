/**
 * Unit Tests: previewLeverage (extracted module)
 *
 * Tests the standalone previewLeverage function with mocked dependencies.
 * No mainnet RPC required.
 *
 * Run: npx vitest run src/__tests__/leveragePreview.unit.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { previewLeverage } from "../strategies/leverage-preview";
import type { PreviewLeverageDeps } from "../strategies/leverage-preview";
import { COIN_TYPES } from "../types";

// ── Mock helpers ─────────────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<PreviewLeverageDeps> = {}): PreviewLeverageDeps {
  const mockProtocol = {
    name: "mock",
    consumesRepaymentCoin: false,
    getAssetRiskParams: vi.fn().mockResolvedValue({
      ltv: 0.75,
      liquidationThreshold: 0.80,
      liquidationBonus: 0.05,
      maxMultiplier: 4.0,
    }),
    getAssetApy: vi.fn().mockImplementation(async (coinType: string) => {
      if (coinType === COIN_TYPES.USDC) {
        return {
          supplyApy: 0.03,
          rewardApy: 0,
          totalSupplyApy: 0.03,
          borrowApy: 0.05,
          borrowRewardApy: 0.01,
        };
      }
      return {
        supplyApy: 0.02,
        rewardApy: 0.01,
        totalSupplyApy: 0.03,
        borrowApy: 0,
        borrowRewardApy: 0,
      };
    }),
    initialize: vi.fn(),
    getPosition: vi.fn(),
    deposit: vi.fn(),
    withdraw: vi.fn(),
    borrow: vi.fn(),
    repay: vi.fn(),
    refreshOracles: vi.fn(),
    getAccountPortfolio: vi.fn(),
  };

  const mockSwapClient = {
    quote: vi.fn().mockResolvedValue([
      { amountOut: "4500000000", amountIn: "100000000", route: [] }, // 4.5 SUI for $100
    ]),
  };

  return {
    protocol: mockProtocol as any,
    swapClient: mockSwapClient as any,
    suiClient: {} as any,
    ...overrides,
  };
}

// Mock external dependencies
vi.mock("@7kprotocol/sdk-ts", () => ({
  MetaAg: vi.fn(),
  getTokenPrice: vi.fn().mockResolvedValue(3.5), // SUI at $3.50
}));

vi.mock("../protocols/scallop/flash-loan", () => ({
  ScallopFlashLoanClient: {
    fetchFlashLoanFeeRate: vi.fn().mockResolvedValue(0), // 0% flash loan fee
    calculateFee: vi.fn().mockReturnValue(0n),
  },
}));

vi.mock("../protocols/suilend/constants", () => ({
  getReserveByCoinType: vi.fn().mockReturnValue({
    decimals: 9,
    symbol: "SUI",
  }),
}));

// ── Tests ────────────────────────────────────────────────────────────────────

describe("previewLeverage (unit)", () => {
  it("calculates correct position metrics for 2x leverage", async () => {
    const deps = createMockDeps();

    const result = await previewLeverage(
      {
        coinType: COIN_TYPES.SUI,
        depositValueUsd: 100,
        multiplier: 2.0,
      },
      deps,
    );

    // Basic sanity
    expect(result.initialEquityUsd).toBeGreaterThan(0);
    expect(result.totalPositionUsd).toBeCloseTo(result.initialEquityUsd * 2.0, 0);
    expect(result.debtUsd).toBeGreaterThan(0);
    expect(result.flashLoanUsdc).toBeGreaterThan(0n);

    // Risk params from mock
    expect(result.assetLtv).toBe(0.75);
    expect(result.maxMultiplier).toBe(4.0);
    expect(result.liquidationThreshold).toBe(0.80);

    // LTV should be reasonable
    expect(result.ltvPercent).toBeGreaterThan(0);
    expect(result.ltvPercent).toBeLessThan(100);

    // Liquidation price should be positive and below current price
    expect(result.liquidationPrice).toBeGreaterThan(0);
    expect(result.priceDropBuffer).toBeGreaterThan(0);
  });

  it("flash loan amount scales with multiplier", async () => {
    const deps = createMockDeps();

    const preview2x = await previewLeverage(
      { coinType: COIN_TYPES.SUI, depositValueUsd: 100, multiplier: 2.0 },
      deps,
    );
    const preview3x = await previewLeverage(
      { coinType: COIN_TYPES.SUI, depositValueUsd: 100, multiplier: 3.0 },
      deps,
    );

    // 3x needs 2x the flash loan of 2x (since flashLoanUsd = equity * (mult - 1))
    const flashLoan2x = Number(preview2x.flashLoanUsdc);
    const flashLoan3x = Number(preview3x.flashLoanUsdc);
    expect(flashLoan3x / flashLoan2x).toBeCloseTo(2.0, 1);
  });

  it("APY breakdown is computed correctly", async () => {
    const deps = createMockDeps();

    const result = await previewLeverage(
      { coinType: COIN_TYPES.SUI, depositValueUsd: 100, multiplier: 2.0 },
      deps,
    );

    // Supply APY from mock
    expect(result.supplyApyBreakdown.base).toBe(0.02);
    expect(result.supplyApyBreakdown.reward).toBe(0.01);
    expect(result.supplyApyBreakdown.total).toBe(0.03);

    // Borrow APY from mock
    expect(result.borrowApyBreakdown.net).toBe(0.05);
    expect(result.borrowApyBreakdown.rebate).toBe(0.01);

    // Net APY = (position * supplyApy - debt * borrowApy) / equity
    const expectedNetApy =
      (result.totalPositionUsd * result.supplyApyBreakdown.total -
        result.debtUsd * result.borrowApyBreakdown.net) /
      result.initialEquityUsd;
    expect(result.netApy).toBeCloseTo(expectedNetApy, 5);
  });

  it("throws on multiplier exceeding max", async () => {
    const deps = createMockDeps();

    await expect(
      previewLeverage(
        { coinType: COIN_TYPES.SUI, depositValueUsd: 100, multiplier: 5.0 },
        deps,
      ),
    ).rejects.toThrow("exceeds protocol max");
  });

  it("throws if neither depositAmount nor depositValueUsd provided", async () => {
    const deps = createMockDeps();

    await expect(
      previewLeverage(
        { coinType: COIN_TYPES.SUI, multiplier: 2.0 },
        deps,
      ),
    ).rejects.toThrow("Either depositAmount or depositValueUsd");
  });

  it("throws if both depositAmount and depositValueUsd provided", async () => {
    const deps = createMockDeps();

    await expect(
      previewLeverage(
        {
          coinType: COIN_TYPES.SUI,
          depositAmount: "10",
          depositValueUsd: 100,
          multiplier: 2.0,
        },
        deps,
      ),
    ).rejects.toThrow("Cannot provide both");
  });

  it("handles swap quote failure gracefully (defaults to 1% slippage)", async () => {
    const deps = createMockDeps({
      swapClient: {
        quote: vi.fn().mockRejectedValue(new Error("Quote failed")),
      } as any,
    });

    const result = await previewLeverage(
      { coinType: COIN_TYPES.SUI, depositValueUsd: 100, multiplier: 2.0 },
      deps,
    );

    expect(result.swapSlippagePct).toBe(1.0); // default fallback
    expect(result.effectiveMultiplier).toBe(2.0); // fallback to requested
  });

  it("calculates swap slippage from quote", async () => {
    // Mock a swap that returns slightly less than theoretical (0.5% slippage)
    const deps = createMockDeps();

    const result = await previewLeverage(
      { coinType: COIN_TYPES.SUI, depositValueUsd: 100, multiplier: 2.0 },
      deps,
    );

    // With the mock returning 4.5 SUI, slippage should be calculable
    expect(result.swapSlippagePct).toBeGreaterThanOrEqual(0);
    // effectiveMultiplier should differ from requested due to slippage
    expect(result.effectiveMultiplier).toBeGreaterThan(1);
  });
});
