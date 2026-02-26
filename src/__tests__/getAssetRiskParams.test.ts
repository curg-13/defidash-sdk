/**
 * getAssetRiskParams — Integration tests
 *
 * Tests each protocol adapter's on-chain LTV query for all SUPPORTED_COIN_TYPES.
 * Validates returned values are within sane ranges and maxMultiplier is
 * correctly derived from LTV.
 *
 * Requires: .env with SUI_FULLNODE_URL (or defaults to public mainnet)
 */

import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { SuilendAdapter } from "../protocols/suilend/adapter";
import { NaviAdapter } from "../protocols/navi/adapter";
import { ScallopAdapter } from "../protocols/scallop/adapter";
import { AssetRiskParams } from "../types/protocol";
import { SUPPORTED_COIN_TYPES, COIN_TYPES } from "../types/constants";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

const COIN_LABELS: Record<string, string> = {
  [COIN_TYPES.SUI]: "SUI",
  [COIN_TYPES.LBTC]: "LBTC",
  [COIN_TYPES.XBTC]: "XBTC",
};

const FALLBACK: AssetRiskParams = {
  ltv: 0.5,
  liquidationThreshold: 0.6,
  liquidationBonus: 0.05,
  maxMultiplier: 2.0,
};

function isFallback(p: AssetRiskParams): boolean {
  return (
    p.ltv === FALLBACK.ltv &&
    p.liquidationThreshold === FALLBACK.liquidationThreshold &&
    p.liquidationBonus === FALLBACK.liquidationBonus &&
    p.maxMultiplier === FALLBACK.maxMultiplier
  );
}

// ─── Shared assertion helpers ────────────────────────────────────────

function assertValidRiskParams(params: AssetRiskParams) {
  // LTV: 0 < ltv < 1
  expect(params.ltv).toBeGreaterThan(0);
  expect(params.ltv).toBeLessThan(1);

  // Liquidation threshold: 0 < threshold <= 1
  // NOTE: Not all protocols guarantee threshold >= LTV.
  // Navi defines liquidationThreshold independently (can be < ltv).
  expect(params.liquidationThreshold).toBeGreaterThan(0);
  expect(params.liquidationThreshold).toBeLessThanOrEqual(1);

  // Liquidation bonus: 0 < bonus < 1
  expect(params.liquidationBonus).toBeGreaterThan(0);
  expect(params.liquidationBonus).toBeLessThan(1);

  // Max multiplier = 1 / (1 - ltv), tolerance 0.01
  const expected = 1 / (1 - params.ltv);
  expect(params.maxMultiplier).toBeCloseTo(expected, 2);

  // Max multiplier must be > 1
  expect(params.maxMultiplier).toBeGreaterThan(1);
}

// ─── Test suites ─────────────────────────────────────────────────────

describe("getAssetRiskParams", () => {
  let suiClient: SuiClient;

  beforeAll(() => {
    suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  });

  // ── Suilend ──────────────────────────────────────────────────────

  describe("Suilend", () => {
    let adapter: SuilendAdapter;

    beforeAll(async () => {
      adapter = new SuilendAdapter();
      await adapter.initialize(suiClient);
    });

    it.each(SUPPORTED_COIN_TYPES.map((ct) => [COIN_LABELS[ct], ct]))(
      "%s — returns valid risk params",
      async (_label, coinType) => {
        const params = await adapter.getAssetRiskParams(coinType);
        assertValidRiskParams(params);
      },
    );

    it("SUI — returns real on-chain LTV, not fallback", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.SUI);
      expect(isFallback(params)).toBe(false);
      // Suilend SUI LTV is known to be ~70%
      expect(params.ltv).toBeGreaterThanOrEqual(0.5);
      expect(params.ltv).toBeLessThanOrEqual(0.85);
    });

    it("SUI — liquidationThreshold >= LTV", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.SUI);
      // Suilend's closeLtvPct (liquidation) >= openLtvPct (borrow)
      expect(params.liquidationThreshold).toBeGreaterThanOrEqual(params.ltv);
    });
  });

  // ── Navi ─────────────────────────────────────────────────────────

  describe("Navi", () => {
    let adapter: NaviAdapter;

    beforeAll(async () => {
      adapter = new NaviAdapter();
      await adapter.initialize(suiClient);
    });

    it.each(SUPPORTED_COIN_TYPES.map((ct) => [COIN_LABELS[ct], ct]))(
      "%s — returns valid risk params",
      async (_label, coinType) => {
        const params = await adapter.getAssetRiskParams(coinType);
        assertValidRiskParams(params);
      },
    );

    it("SUI — returns real on-chain LTV, not fallback", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.SUI);
      expect(isFallback(params)).toBe(false);
      // Navi SUI LTV is known to be ~75%
      expect(params.ltv).toBeGreaterThanOrEqual(0.5);
      expect(params.ltv).toBeLessThanOrEqual(0.85);
    });

    it("SUI — liquidationThreshold is within valid range", async () => {
      // Navi defines liquidationThreshold independently from LTV.
      // It can be lower than LTV (e.g., ltv=0.75, liqThreshold=0.70).
      const params = await adapter.getAssetRiskParams(COIN_TYPES.SUI);
      expect(params.liquidationThreshold).toBeGreaterThan(0.5);
      expect(params.liquidationThreshold).toBeLessThan(1);
    });
  });

  // ── Scallop ──────────────────────────────────────────────────────

  describe("Scallop", () => {
    let adapter: ScallopAdapter;

    beforeAll(async () => {
      adapter = new ScallopAdapter();
      await adapter.initialize(suiClient);
    });

    it.each(SUPPORTED_COIN_TYPES.map((ct) => [COIN_LABELS[ct], ct]))(
      "%s — returns valid risk params (may be fallback)",
      async (_label, coinType) => {
        // Scallop's queryMarket() may throw internally (SDK bug in isLayerZeroAsset),
        // causing fallback values. We still validate the returned shape.
        const params = await adapter.getAssetRiskParams(coinType);
        assertValidRiskParams(params);
      },
    );

    it("SUI — returns params without throwing", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.SUI);
      // queryMarket() has a known SDK bug — may return fallback.
      // We verify the adapter handles it gracefully (no throw).
      expect(params.ltv).toBeGreaterThan(0);
      expect(params.maxMultiplier).toBeGreaterThan(1);
      if (isFallback(params)) {
        console.warn(
          "  ⚠ Scallop SUI returned fallback (queryMarket SDK bug)",
        );
      }
    });
  });

  // ── Cross-protocol comparison ────────────────────────────────────

  describe("Cross-protocol", () => {
    let suilend: SuilendAdapter;
    let navi: NaviAdapter;

    beforeAll(async () => {
      suilend = new SuilendAdapter();
      navi = new NaviAdapter();
      await Promise.all([
        suilend.initialize(suiClient),
        navi.initialize(suiClient),
      ]);
    });

    it("SUI — Suilend and Navi return different LTV", async () => {
      const [s, n] = await Promise.all([
        suilend.getAssetRiskParams(COIN_TYPES.SUI),
        navi.getAssetRiskParams(COIN_TYPES.SUI),
      ]);

      // Different protocols should have different LTV — proves real on-chain reads
      expect(s.ltv.toFixed(4)).not.toBe(n.ltv.toFixed(4));
    });

    it("higher LTV → higher maxMultiplier (Suilend vs Navi)", async () => {
      const [s, n] = await Promise.all([
        suilend.getAssetRiskParams(COIN_TYPES.SUI),
        navi.getAssetRiskParams(COIN_TYPES.SUI),
      ]);

      const sorted = [s, n].sort((a, b) => a.ltv - b.ltv);
      expect(sorted[1].maxMultiplier).toBeGreaterThanOrEqual(
        sorted[0].maxMultiplier,
      );
    });
  });
});
