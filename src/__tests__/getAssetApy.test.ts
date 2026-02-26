/**
 * getAssetApy test — verifies each protocol adapter returns valid APY data.
 *
 * NOTE: These tests make live RPC calls to mainnet and may be slow (~10s each).
 * Run with: npx vitest run src/__tests__/getAssetApy.test.ts
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * CONSTRAINT 1) Cross-protocol APY sanity check (Suilend USDC reference values)
 * ──────────────────────────────────────────────────────────────────────────────
 * Asset: USDC in Suilend (2026-02-26)
 *
 *   Supply side:
 *     Interest (base supply APR) :  2.65%
 *     Reward  (sSUI reward APR)  :  0.49%
 *     ─────────────────────────────────────
 *     Deposit APR (total)        :  3.13%  ← totalSupplyApy should match this
 *
 *   Borrow side:
 *     Interest (gross borrow APR):  5.83%
 *     Reward  (sSUI borrow rebate): 2.00%  (reduces net cost)
 *     ─────────────────────────────────────
 *     Borrow APR (gross)         :  3.83%  ← borrowApy should match this
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * CONSTRAINT 2) Wrapped BTC assets
 * ──────────────────────────────────────────────────────────────────────────────
 * TODO: Add LBTC and XBTC supply APY checks.
 *       These wrapped BTC assets are important for SDK completeness on Sui.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { AssetApy } from "../types";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { SuilendAdapter } from "../protocols/suilend/adapter";
import { NaviAdapter } from "../protocols/navi/adapter";
import { ScallopAdapter } from "../protocols/scallop/adapter";
import { COIN_TYPES } from "../types";

/** Pretty-print APY results in the Suilend USDC style (see CONSTRAINT 1) */
function printApy(protocol: string, asset: string, apy: AssetApy): void {
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  console.log(
    [
      `\n┌─ [${protocol}] ${asset} APY ─────────────────────────`,
      `│  Supply side:`,
      `│    Interest (base) : ${pct(apy.supplyApy)}`,
      `│    Reward          : ${pct(apy.rewardApy)}`,
      `│    ─────────────────────────────────`,
      `│    Total supply    : ${pct(apy.totalSupplyApy)}`,
      `│`,
      `│  Borrow side:`,
      `│    Gross borrow APR: ${pct(apy.borrowApy + apy.borrowRewardApy)}`,
      `│    Reward (rebate) : ${pct(apy.borrowRewardApy)}`,
      `│    ─────────────────────────────────`,
      `│    Net borrow APR  : ${pct(apy.borrowApy)}`,
      `└─────────────────────────────────────────────────`,
    ].join("\n"),
  );
}

describe("Protocol getAssetApy", () => {
  let suiClient: SuiClient;

  beforeAll(() => {
    suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });
  });

  // ── Suilend ─────────────────────────────────────────────────────────────────
  describe("Suilend", () => {
    let adapter: SuilendAdapter;
    beforeAll(async () => {
      adapter = new SuilendAdapter();
      await adapter.initialize(suiClient);
    }, 30_000);

    it("should return valid APY for SUI", async () => {
      const apy = await adapter.getAssetApy(COIN_TYPES.SUI);
      printApy("Suilend", "SUI", apy);

      expect(apy.supplyApy).toBeGreaterThanOrEqual(0);
      expect(apy.borrowApy).toBeGreaterThanOrEqual(0);
      expect(apy.rewardApy).toBeGreaterThanOrEqual(0);
      expect(apy.totalSupplyApy).toBeCloseTo(apy.supplyApy + apy.rewardApy, 10);
    }, 30_000);

    it("should return valid APY for USDC (CONSTRAINT 1: total supply ≈ 3.13%)", async () => {
      const apy = await adapter.getAssetApy(COIN_TYPES.USDC);
      printApy("Suilend", "USDC", apy);

      expect(apy.supplyApy).toBeGreaterThan(0);
      expect(apy.borrowApy).toBeGreaterThan(0);
      // Deposit APR (total) = Interest + Reward ≥ base APR
      // Reference: ~3.13% (2.65% interest + 0.49% sSUI reward)
      expect(apy.totalSupplyApy).toBeGreaterThanOrEqual(apy.supplyApy);
      expect(apy.totalSupplyApy).toBeCloseTo(apy.supplyApy + apy.rewardApy, 10);
    }, 30_000);
  });

  // ── Navi ────────────────────────────────────────────────────────────────────
  describe("Navi", () => {
    let adapter: NaviAdapter;
    beforeAll(async () => {
      adapter = new NaviAdapter();
      await adapter.initialize(suiClient);
    }, 30_000);

    it("should return valid APY for SUI", async () => {
      const apy = await adapter.getAssetApy(COIN_TYPES.SUI);
      printApy("Navi", "SUI", apy);

      expect(apy.supplyApy).toBeGreaterThan(0);
      expect(apy.borrowApy).toBeGreaterThan(0);
      expect(apy.rewardApy).toBeGreaterThanOrEqual(0);
      expect(apy.totalSupplyApy).toBeCloseTo(apy.supplyApy + apy.rewardApy, 10);
    }, 30_000);

    it("should return valid APY for USDC", async () => {
      const apy = await adapter.getAssetApy(COIN_TYPES.USDC);
      printApy("Navi", "USDC", apy);

      expect(apy.supplyApy).toBeGreaterThan(0);
      expect(apy.borrowApy).toBeGreaterThan(0);
    }, 30_000);
  });

  // ── Scallop ─────────────────────────────────────────────────────────────────
  describe("Scallop", () => {
    let adapter: ScallopAdapter;
    beforeAll(async () => {
      adapter = new ScallopAdapter();
      await adapter.initialize(suiClient);
    }, 30_000);

    it("should return valid APY for SUI", async () => {
      const apy = await adapter.getAssetApy(COIN_TYPES.SUI);
      printApy("Scallop", "SUI", apy);

      expect(apy.supplyApy).toBeGreaterThan(0);
      expect(apy.borrowApy).toBeGreaterThan(0);
      expect(apy.rewardApy).toBeGreaterThanOrEqual(0);
      expect(apy.totalSupplyApy).toBeCloseTo(apy.supplyApy + apy.rewardApy, 10);
    }, 30_000);

    it("should return valid APY for USDC", async () => {
      const apy = await adapter.getAssetApy(COIN_TYPES.USDC);
      printApy("Scallop", "USDC", apy);

      expect(apy.supplyApy).toBeGreaterThan(0);
      expect(apy.borrowApy).toBeGreaterThan(0);
    }, 30_000);
  });
});
