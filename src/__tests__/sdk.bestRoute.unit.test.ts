/**
 * SDK Method: sdk.findBestLeverageRoute()  [Unit]
 *
 * Tests findBestLeverageRoute() with mocked dependencies. No mainnet RPC.
 *
 * Mocked internal dependencies:
 *   - previewFn()                    → returns mock LeveragePreview per protocol
 *   - protocol.getAssetRiskParams()  → returns mock risk params (ltv, maxMultiplier)
 *   - resolveCoinType()              → returns COIN_TYPES.SUI
 *
 * Integration test counterpart: sdk.bestRoute.test.ts
 *
 * Run: npx vitest run src/__tests__/sdk.bestRoute.unit.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { findBestLeverageRoute } from "../strategies/leverage-route";
import type { FindBestRouteDeps } from "../strategies/leverage-route";
import { LendingProtocol, COIN_TYPES } from "../types";
import type { LeveragePreview, ILendingProtocol } from "../types";

// ── Mock helpers ─────────────────────────────────────────────────────────────

function makeMockProtocol(
  name: string,
  ltv: number,
  maxMultiplier: number,
): ILendingProtocol {
  return {
    name,
    consumesRepaymentCoin: false,
    getAssetRiskParams: vi.fn().mockResolvedValue({
      ltv,
      liquidationThreshold: ltv + 0.05,
      liquidationBonus: 0.05,
      maxMultiplier,
    }),
    getAssetApy: vi.fn(),
    initialize: vi.fn(),
    getPosition: vi.fn(),
    deposit: vi.fn(),
    withdraw: vi.fn(),
    borrow: vi.fn(),
    repay: vi.fn(),
    refreshOracles: vi.fn(),
    getAccountPortfolio: vi.fn(),
  } as any;
}

function makePreview(netApy: number, maxMultiplier = 3.0): LeveragePreview {
  return {
    initialEquityUsd: 100,
    flashLoanUsdc: 100_000_000n,
    flashLoanFeeUsd: 0,
    totalPositionUsd: 200,
    debtUsd: 100,
    effectiveMultiplier: 2.0,
    maxMultiplier,
    assetLtv: 0.65,
    ltvPercent: 50,
    liquidationThreshold: 0.70,
    liquidationPrice: 1.0,
    priceDropBuffer: 30,
    supplyApyBreakdown: { base: 0.03, reward: 0, total: 0.03 },
    borrowApyBreakdown: { gross: 0.05, rebate: 0, net: 0.05 },
    netApy,
    annualNetEarningsUsd: netApy * 100,
    swapSlippagePct: 0.5,
  };
}

function createMockDeps(
  protocolMap: Map<LendingProtocol, ILendingProtocol>,
  previewResults: Map<LendingProtocol, LeveragePreview>,
): FindBestRouteDeps {
  return {
    protocols: protocolMap,
    previewFn: vi.fn().mockImplementation(async (protocol: LendingProtocol) => {
      const preview = previewResults.get(protocol);
      if (!preview) throw new Error(`No preview for ${protocol}`);
      return preview;
    }),
    resolveCoinType: vi.fn().mockReturnValue(COIN_TYPES.SUI),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("findBestLeverageRoute (unit)", () => {
  it("selects protocol with highest maxMultiplier for bestMaxMultiplier", async () => {
    const protocols = new Map<LendingProtocol, ILendingProtocol>([
      [LendingProtocol.Suilend, makeMockProtocol("suilend", 0.65, 2.86)],
      [LendingProtocol.Scallop, makeMockProtocol("scallop", 0.85, 6.67)],
      [LendingProtocol.Navi, makeMockProtocol("navi", 0.75, 4.0)],
    ]);

    const previews = new Map([
      [LendingProtocol.Suilend, makePreview(0.05, 2.86)],
      [LendingProtocol.Scallop, makePreview(0.03, 6.67)],
      [LendingProtocol.Navi, makePreview(0.04, 4.0)],
    ]);

    const deps = createMockDeps(protocols, previews);

    const result = await findBestLeverageRoute(
      { depositAsset: "SUI", depositValueUsd: 100 },
      deps,
    );

    expect(result.bestMaxMultiplier.protocol).toBe(LendingProtocol.Scallop);
  });

  it("selects protocol with highest netApy for bestApy", async () => {
    const protocols = new Map<LendingProtocol, ILendingProtocol>([
      [LendingProtocol.Suilend, makeMockProtocol("suilend", 0.65, 2.86)],
      [LendingProtocol.Scallop, makeMockProtocol("scallop", 0.85, 6.67)],
      [LendingProtocol.Navi, makeMockProtocol("navi", 0.75, 4.0)],
    ]);

    const previews = new Map([
      [LendingProtocol.Suilend, makePreview(0.08)],  // Best APY
      [LendingProtocol.Scallop, makePreview(0.03)],
      [LendingProtocol.Navi, makePreview(0.04)],
    ]);

    const deps = createMockDeps(protocols, previews);

    const result = await findBestLeverageRoute(
      { depositAsset: "SUI", depositValueUsd: 100 },
      deps,
    );

    expect(result.bestApy.protocol).toBe(LendingProtocol.Suilend);
    expect(result.bestApy.preview.netApy).toBe(0.08);
  });

  it("calculates safeMultiplier as min(maxMultipliers) - buffer", async () => {
    const protocols = new Map<LendingProtocol, ILendingProtocol>([
      [LendingProtocol.Suilend, makeMockProtocol("suilend", 0.65, 2.86)],
      [LendingProtocol.Navi, makeMockProtocol("navi", 0.75, 4.0)],
    ]);

    const previews = new Map([
      [LendingProtocol.Suilend, makePreview(0.05)],
      [LendingProtocol.Navi, makePreview(0.04)],
    ]);

    const deps = createMockDeps(protocols, previews);

    const result = await findBestLeverageRoute(
      { depositAsset: "SUI", depositValueUsd: 100 },
      deps,
    );

    // safeMultiplier = min(2.86, 4.0) - 0.5 = 2.36
    expect(result.safeMultiplier).toBeCloseTo(2.36, 1);
  });

  it("floors safeMultiplier at 1.1", async () => {
    const protocols = new Map<LendingProtocol, ILendingProtocol>([
      [LendingProtocol.Suilend, makeMockProtocol("suilend", 0.30, 1.43)],
    ]);

    const previews = new Map([
      [LendingProtocol.Suilend, makePreview(0.02)],
    ]);

    const deps = createMockDeps(protocols, previews);

    const result = await findBestLeverageRoute(
      { depositAsset: "SUI", depositValueUsd: 100 },
      deps,
    );

    // safeMultiplier = max(1.1, 1.43 - 0.5) = max(1.1, 0.93) = 1.1
    expect(result.safeMultiplier).toBe(1.1);
  });

  it("includes allPreviews and failedProtocols", async () => {
    const failingProtocol = makeMockProtocol("navi", 0.75, 4.0);
    (failingProtocol.getAssetRiskParams as any).mockRejectedValue(
      new Error("Asset not supported"),
    );

    const protocols = new Map<LendingProtocol, ILendingProtocol>([
      [LendingProtocol.Suilend, makeMockProtocol("suilend", 0.65, 2.86)],
      [LendingProtocol.Navi, failingProtocol],
    ]);

    const previews = new Map([
      [LendingProtocol.Suilend, makePreview(0.05)],
    ]);

    const deps = createMockDeps(protocols, previews);

    const result = await findBestLeverageRoute(
      { depositAsset: "SUI", depositValueUsd: 100 },
      deps,
    );

    expect(result.allPreviews).toHaveLength(1);
    expect(result.failedProtocols).toHaveLength(1);
    expect(result.failedProtocols[0].protocol).toBe(LendingProtocol.Navi);
  });

  it("throws if no protocol supports the asset", async () => {
    const failing = makeMockProtocol("suilend", 0, 0);
    (failing.getAssetRiskParams as any).mockRejectedValue(
      new Error("Not supported"),
    );

    const protocols = new Map<LendingProtocol, ILendingProtocol>([
      [LendingProtocol.Suilend, failing],
    ]);

    const deps = createMockDeps(protocols, new Map());

    await expect(
      findBestLeverageRoute(
        { depositAsset: "SUI", depositValueUsd: 100 },
        deps,
      ),
    ).rejects.toThrow("No protocol supports asset");
  });

  it("throws if neither depositAmount nor depositValueUsd provided", async () => {
    const protocols = new Map<LendingProtocol, ILendingProtocol>();
    const deps = createMockDeps(protocols, new Map());

    await expect(
      findBestLeverageRoute(
        { depositAsset: "SUI" },
        deps,
      ),
    ).rejects.toThrow("Either depositAmount or depositValueUsd");
  });
});
