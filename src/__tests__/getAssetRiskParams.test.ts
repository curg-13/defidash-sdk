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

// ─── Pretty-print helper ────────────────────────────────────────────

function printRiskParams(
  protocol: string,
  asset: string,
  params: AssetRiskParams,
): void {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const fb = isFallback(params) ? " (FALLBACK)" : "";
  console.log(
    [
      `\n┌─ [${protocol}] ${asset} Risk Params${fb} ──────────────`,
      `│  LTV (borrow limit)      : ${pct(params.ltv)}`,
      `│  Liquidation Threshold   : ${pct(params.liquidationThreshold)}`,
      `│  Liquidation Bonus       : ${pct(params.liquidationBonus)}`,
      `│  Max Multiplier          : ${params.maxMultiplier.toFixed(2)}x`,
      `└──────────────────────────────────────────────────`,
    ].join("\n"),
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
      async (label, coinType) => {
        const params = await adapter.getAssetRiskParams(coinType);
        printRiskParams("Suilend", label, params);
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
      expect(params.liquidationThreshold).toBeGreaterThanOrEqual(params.ltv);
    });

    it("LBTC — returns real on-chain LTV, not fallback", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.LBTC);
      expect(isFallback(params)).toBe(false);
      expect(params.ltv).toBeGreaterThanOrEqual(0.4);
      expect(params.ltv).toBeLessThanOrEqual(0.8);
      expect(params.liquidationThreshold).toBeGreaterThanOrEqual(params.ltv);
    });

    it("XBTC — returns real on-chain LTV, not fallback", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.XBTC);
      expect(isFallback(params)).toBe(false);
      expect(params.ltv).toBeGreaterThanOrEqual(0.4);
      expect(params.ltv).toBeLessThanOrEqual(0.8);
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
      async (label, coinType) => {
        const params = await adapter.getAssetRiskParams(coinType);
        printRiskParams("Navi", label, params);
        assertValidRiskParams(params);
      },
    );

    it("SUI — returns real on-chain LTV, not fallback", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.SUI);
      expect(isFallback(params)).toBe(false);
      expect(params.ltv).toBeGreaterThanOrEqual(0.5);
      expect(params.ltv).toBeLessThanOrEqual(0.85);
    });

    it("SUI — liquidationThreshold is within valid range", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.SUI);
      expect(params.liquidationThreshold).toBeGreaterThan(0.5);
      expect(params.liquidationThreshold).toBeLessThan(1);
    });

    it("LBTC — LTV ~55%, LT ~70%", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.LBTC);
      expect(isFallback(params)).toBe(false);
      expect(params.ltv).toBeCloseTo(0.55, 1);
      expect(params.liquidationThreshold).toBeCloseTo(0.70, 1);
    });

    it("XBTC — LTV ~67%, LT ~70%", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.XBTC);
      expect(isFallback(params)).toBe(false);
      expect(params.ltv).toBeCloseTo(0.67, 1);
      expect(params.liquidationThreshold).toBeCloseTo(0.70, 1);
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
      async (label, coinType) => {
        const params = await adapter.getAssetRiskParams(coinType);
        printRiskParams("Scallop", label, params);
        assertValidRiskParams(params);
      },
    );

    it("SUI — returns real on-chain LTV via direct contract query", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.SUI);
      expect(isFallback(params)).toBe(false);
      // Scallop SUI: LTV ~85%, LT ~90%
      expect(params.ltv).toBeGreaterThanOrEqual(0.7);
      expect(params.ltv).toBeLessThanOrEqual(0.9);
      expect(params.liquidationThreshold).toBeGreaterThanOrEqual(params.ltv);
    });

    it("LBTC — returns fallback (not a Scallop collateral)", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.LBTC);
      expect(isFallback(params)).toBe(true);
    });

    it("XBTC — returns real on-chain LTV", async () => {
      const params = await adapter.getAssetRiskParams(COIN_TYPES.XBTC);
      expect(isFallback(params)).toBe(false);
      // Scallop XBTC: LTV ~75%, LT ~80%
      expect(params.ltv).toBeGreaterThanOrEqual(0.6);
      expect(params.ltv).toBeLessThanOrEqual(0.85);
      expect(params.liquidationThreshold).toBeGreaterThanOrEqual(params.ltv);
    });
  });

});
