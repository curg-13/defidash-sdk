/**
 * Integration Tests: previewLeverage
 *
 * Verifies all output fields of sdk.previewLeverage() across protocols:
 *   - Position metrics (equity, flash loan, LTV, liquidation price)
 *   - APY breakdown (supply, borrow, net)
 *   - Fee accuracy (on-chain flash loan fee from Scallop)
 *   - Swap slippage (from live 7k quote)
 *
 * Run: npx vitest run src/__tests__/previewLeverage.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { DefiDashSDK, LendingProtocol } from '..';
import type { LeveragePreview } from '../types/strategy';

// ── Print helper ─────────────────────────────────────────────────────────────
function printPreview(
  protocol: string,
  asset: string,
  mult: number,
  p: LeveragePreview,
): void {
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const usd = (v: number) => `$${v.toFixed(4)}`;
  console.log(
    [
      `\n┌─ [${protocol}] ${asset} ${mult}x ──────────────────────────────────────`,
      `│  Risk Params (from getAssetRiskParams):`,
      `│    Asset LTV         : ${pct(p.assetLtv)}`,
      `│    Liq. Threshold    : ${pct(p.liquidationThreshold)}`,
      `│    Max Multiplier    : ${p.maxMultiplier.toFixed(2)}x`,
      `│`,
      `│  Position:`,
      `│    Initial Equity   : ${usd(p.initialEquityUsd)}`,
      `│    Flash Loan (USDC): ${(Number(p.flashLoanUsdc) / 1e6).toFixed(4)} USDC`,
      `│    Flash Loan Fee   : ${usd(p.flashLoanFeeUsd)}`,
      `│    Total Position   : ${usd(p.totalPositionUsd)}`,
      `│    Total Debt       : ${usd(p.debtUsd)}`,
      `│    Effective Mult   : ${p.effectiveMultiplier.toFixed(3)}x`,
      `│    Position LTV     : ${p.ltvPercent.toFixed(2)}%`,
      `│    Liq. Price       : ${usd(p.liquidationPrice)}`,
      `│    Price Drop Buf   : ${p.priceDropBuffer.toFixed(2)}%`,
      `│`,
      `│  Supply APY (${asset}):`,
      `│    Base             : ${pct(p.supplyApyBreakdown.base)}`,
      `│    Reward           : ${pct(p.supplyApyBreakdown.reward)}`,
      `│    Total            : ${pct(p.supplyApyBreakdown.total)}`,
      `│`,
      `│  Borrow APY (USDC):`,
      `│    Gross            : ${pct(p.borrowApyBreakdown.gross)}`,
      `│    Rebate           : ${pct(p.borrowApyBreakdown.rebate)}`,
      `│    Net              : ${pct(p.borrowApyBreakdown.net)}`,
      `│`,
      `│  Earnings:`,
      `│    Net Position APY : ${pct(p.netApy)}`,
      `│    Annual Earnings  : ${usd(p.annualNetEarningsUsd)}`,
      `│    Swap Slippage    : ${p.swapSlippagePct.toFixed(4)}%`,
      `└──────────────────────────────────────────────────────────────────`,
    ].join('\n'),
  );
}

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// ── SDK Setup ─────────────────────────────────────────────────────────────────
let sdk: DefiDashSDK;

const SECRET_KEY = process.env.SECRET_KEY || process.env.SUI_SECRET_KEY;

beforeAll(async () => {
  if (!SECRET_KEY) throw new Error('SECRET_KEY env is required');
  const suiClient = new SuiClient({
    url: process.env.SUI_FULLNODE_URL || getFullnodeUrl('mainnet'),
  });
  const keypair = Ed25519Keypair.fromSecretKey(SECRET_KEY as any);
  sdk = new DefiDashSDK({ secretKey: SECRET_KEY });
  await sdk.initialize(suiClient, keypair);
}, 60_000);

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getPreview(
  protocol: LendingProtocol,
  asset: string,
  multiplier = 2.0,
): Promise<LeveragePreview> {
  return sdk.previewLeverage({
    protocol,
    depositAsset: asset,
    depositValueUsd: 100,
    multiplier,
  });
}

function assertBaseFields(p: LeveragePreview, multiplier: number) {
  // ── Risk Params (from getAssetRiskParams) ─────────────────────────────────
  // These must match the protocol adapter's on-chain values
  expect(p.assetLtv).toBeGreaterThan(0);
  expect(p.assetLtv).toBeLessThan(1);
  expect(p.liquidationThreshold).toBeGreaterThan(0);
  expect(p.liquidationThreshold).toBeLessThanOrEqual(1);
  // maxMultiplier = 1 / (1 - ltv)
  expect(p.maxMultiplier).toBeCloseTo(1 / (1 - p.assetLtv), 2);
  expect(p.maxMultiplier).toBeGreaterThan(1);

  // ── Position sanity ───────────────────────────────────────────────────────
  expect(p.initialEquityUsd).toBeGreaterThan(0);
  expect(p.totalPositionUsd).toBeCloseTo(p.initialEquityUsd * multiplier, 0);
  expect(p.flashLoanFeeUsd).toBeGreaterThanOrEqual(0);
  expect(p.debtUsd).toBeGreaterThan(0);
  expect(p.ltvPercent).toBeGreaterThan(0);
  expect(p.ltvPercent).toBeLessThan(100);
  expect(p.liquidationPrice).toBeGreaterThan(0);
  expect(p.priceDropBuffer).toBeGreaterThan(0);
  expect(p.effectiveMultiplier).toBeGreaterThan(1);

  // ── APY sanity (base can be 0 for some assets like LBTC) ─────────────────
  expect(p.supplyApyBreakdown.base).toBeGreaterThanOrEqual(0);
  expect(p.supplyApyBreakdown.total).toBeGreaterThanOrEqual(
    p.supplyApyBreakdown.base,
  );
  expect(p.borrowApyBreakdown.gross).toBeGreaterThanOrEqual(
    p.borrowApyBreakdown.net,
  );
  // Net APY = (totalPosition × supplyApy - debt × borrowApy) / equity
  const expectedNetApy =
    (p.totalPositionUsd * p.supplyApyBreakdown.total -
      p.debtUsd * p.borrowApyBreakdown.net) /
    p.initialEquityUsd;
  expect(p.netApy).toBeCloseTo(expectedNetApy, 5);

  // Swap slippage should be in [0, 10%] (sometimes up to 5-6% on live pools)
  expect(p.swapSlippagePct).toBeGreaterThanOrEqual(0);
  expect(p.swapSlippagePct).toBeLessThan(10);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('previewLeverage Integration', () => {
  describe('Suilend', () => {
    it('SUI 2x – all fields valid', async () => {
      const p = await getPreview(LendingProtocol.Suilend, 'SUI', 2.0);
      printPreview('Suilend', 'SUI', 2.0, p);
      assertBaseFields(p, 2.0);
      // Risk params consistency (verified in getAssetRiskParams.test.ts)
      // Suilend SUI: LTV ~70%, LT ~75%, maxMult ~3.33x
      expect(p.assetLtv).toBeGreaterThanOrEqual(0.5);
      expect(p.assetLtv).toBeLessThanOrEqual(0.85);
      expect(p.liquidationThreshold).toBeGreaterThanOrEqual(p.assetLtv);
      // APY: Suilend SUI known supply ≈ 2.89%
      expect(p.supplyApyBreakdown.base).toBeGreaterThan(0.01); // > 1%
    }, 60_000);

    it('XBTC 2x – BTC leverage', async () => {
      const p = await getPreview(LendingProtocol.Suilend, 'XBTC', 2.0);
      printPreview('Suilend', 'XBTC', 2.0, p);
      assertBaseFields(p, 2.0);
      // Risk params: Suilend XBTC LTV ~60%, LT ~65%
      expect(p.assetLtv).toBeGreaterThanOrEqual(0.4);
      expect(p.assetLtv).toBeLessThanOrEqual(0.8);
      expect(p.liquidationThreshold).toBeGreaterThanOrEqual(p.assetLtv);
      // XBTC price >$50k → liquidation price should be high
      expect(p.liquidationPrice).toBeGreaterThan(1000);
    }, 60_000);
  });

  describe('Navi', () => {
    it('SUI 2x – all fields valid', async () => {
      const p = await getPreview(LendingProtocol.Navi, 'SUI', 2.0);
      printPreview('Navi', 'SUI', 2.0, p);
      assertBaseFields(p, 2.0);
      // Risk params: Navi SUI LTV ~75%, LT ~70% (Navi: LT can be < LTV)
      expect(p.assetLtv).toBeGreaterThanOrEqual(0.5);
      expect(p.assetLtv).toBeLessThanOrEqual(0.85);
    }, 60_000);

    it('XBTC 2x – BTC leverage', async () => {
      const p = await getPreview(LendingProtocol.Navi, 'XBTC', 2.0);
      printPreview('Navi', 'XBTC', 2.0, p);
      assertBaseFields(p, 2.0);
      // Risk params: Navi XBTC LTV ~67%, LT ~70%
      expect(p.assetLtv).toBeCloseTo(0.67, 1);
      expect(p.liquidationThreshold).toBeCloseTo(0.70, 1);
    }, 60_000);
  });

  describe('Scallop', () => {
    it('SUI 2x – all fields valid + flash loan fee from on-chain', async () => {
      const p = await getPreview(LendingProtocol.Scallop, 'SUI', 2.0);
      printPreview('Scallop', 'SUI', 2.0, p);
      assertBaseFields(p, 2.0);
      // Risk params: Scallop SUI LTV ~85%, LT ~90%, maxMult ~6.67x
      expect(p.assetLtv).toBeGreaterThanOrEqual(0.7);
      expect(p.assetLtv).toBeLessThanOrEqual(0.9);
      expect(p.liquidationThreshold).toBeGreaterThanOrEqual(p.assetLtv);
      // Flash loan fee is 0% on Scallop currently (verified on-chain)
      expect(p.flashLoanFeeUsd).toBe(0);
    }, 60_000);

    it('XBTC 2x – BTC leverage', async () => {
      const p = await getPreview(LendingProtocol.Scallop, 'XBTC', 2.0);
      printPreview('Scallop', 'XBTC', 2.0, p);
      assertBaseFields(p, 2.0);
      // Risk params: Scallop XBTC LTV ~75%, LT ~80%, maxMult ~4.00x
      expect(p.assetLtv).toBeGreaterThanOrEqual(0.6);
      expect(p.assetLtv).toBeLessThanOrEqual(0.85);
      expect(p.liquidationThreshold).toBeGreaterThanOrEqual(p.assetLtv);
      // XBTC price >$50k → liquidation price should be high
      expect(p.liquidationPrice).toBeGreaterThan(1000);
    }, 60_000);
  });
});
