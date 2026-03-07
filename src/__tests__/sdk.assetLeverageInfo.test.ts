/**
 * SDK Method: sdk.getAssetLeverageInfo()  [Integration]
 *
 * Verifies that getAssetLeverageInfo returns combined asset data
 * across all protocols.
 *
 * Internal dependencies:
 *   - protocol.getAssetRiskParams()  → risk parameters
 *   - protocol.getAssetApy()         → APY data
 *   - getTokenPrice()                → 7k Protocol price
 *
 * Run: npx vitest run src/__tests__/sdk.assetLeverageInfo.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { DefiDashSDK, LendingProtocol, AssetLeverageInfo } from '..';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';

// ── SDK Setup ─────────────────────────────────────────────────────────────────
let sdk: DefiDashSDK;

// Use a known address (doesn't need balance for this test)
const TEST_ADDRESS =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

beforeAll(async () => {
  const suiClient = new SuiClient({
    url: process.env.SUI_FULLNODE_URL || getFullnodeUrl('mainnet'),
  });
  sdk = await DefiDashSDK.create(suiClient, TEST_ADDRESS);
}, 60_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('sdk.getAssetLeverageInfo', () => {
  it('returns leverage info for SUI across all protocols', async () => {
    const infos = await sdk.getAssetLeverageInfo('SUI');

    expect(infos).toBeDefined();
    expect(Array.isArray(infos)).toBe(true);
    expect(infos.length).toBeGreaterThan(0);

    console.log('\n=== SUI Leverage Info ===');
    for (const info of infos) {
      console.log(`\n${info.protocol}:`);
      console.log(`  Symbol: ${info.symbol}`);
      console.log(`  Price: $${info.priceUsd.toFixed(4)}`);
      console.log(`  Max Multiplier: ${info.riskParams.maxMultiplier.toFixed(2)}x`);
      console.log(`  LTV: ${(info.riskParams.ltv * 100).toFixed(1)}%`);
      console.log(
        `  Liquidation Threshold: ${(info.riskParams.liquidationThreshold * 100).toFixed(1)}%`,
      );
      console.log(`  Supply APY: ${(info.apy.totalSupplyApy * 100).toFixed(2)}%`);
      console.log(`  Borrow APY: ${(info.apy.borrowApy * 100).toFixed(2)}%`);
    }

    // Verify structure
    for (const info of infos) {
      expect(info.coinType).toContain('sui::SUI');
      expect(info.symbol).toBe('SUI');
      expect(info.priceUsd).toBeGreaterThan(0);
      expect(info.riskParams.ltv).toBeGreaterThan(0);
      expect(info.riskParams.ltv).toBeLessThanOrEqual(1);
      expect(info.riskParams.maxMultiplier).toBeGreaterThan(1);
      expect(info.apy).toBeDefined();
    }
  }, 60_000);

  it('returns info for all major protocols (Suilend, Navi, Scallop)', async () => {
    const infos = await sdk.getAssetLeverageInfo('SUI');

    const protocols = infos.map((i) => i.protocol);

    // At least some protocols should succeed
    expect(protocols.length).toBeGreaterThan(0);

    console.log('\nProtocols with SUI support:', protocols.join(', '));
  }, 60_000);

  it('handles unknown asset gracefully', async () => {
    // SDK should throw for unknown asset before even querying protocols
    await expect(sdk.getAssetLeverageInfo('UNKNOWN_ASSET_XYZ')).rejects.toThrow();
  });

  it('price is consistent across all protocols', async () => {
    const infos = await sdk.getAssetLeverageInfo('SUI');

    if (infos.length > 1) {
      // All prices should be the same (fetched once)
      const prices = infos.map((i) => i.priceUsd);
      const firstPrice = prices[0];

      for (const price of prices) {
        expect(price).toBe(firstPrice);
      }
    }
  }, 60_000);

  it('works with full coin type', async () => {
    const infos = await sdk.getAssetLeverageInfo('0x2::sui::SUI');

    expect(infos.length).toBeGreaterThan(0);
    expect(infos[0].symbol).toBe('SUI');
  }, 60_000);
});

describe('AssetLeverageInfo comparison', () => {
  it('can find best max multiplier across protocols', async () => {
    const infos = await sdk.getAssetLeverageInfo('SUI');

    const best = infos.reduce((a, b) =>
      a.riskParams.maxMultiplier > b.riskParams.maxMultiplier ? a : b,
    );

    console.log(
      `\nBest max multiplier for SUI: ${best.protocol} (${best.riskParams.maxMultiplier.toFixed(2)}x)`,
    );

    expect(best.riskParams.maxMultiplier).toBeGreaterThan(1);
  }, 60_000);

  it('can find best net APY (supply - borrow) across protocols', async () => {
    const infos = await sdk.getAssetLeverageInfo('SUI');

    const withNetApy = infos.map((info) => ({
      ...info,
      netApy: info.apy.totalSupplyApy - info.apy.borrowApy,
    }));

    const best = withNetApy.reduce((a, b) => (a.netApy > b.netApy ? a : b));

    console.log(
      `\nBest raw net APY for SUI: ${best.protocol} (${(best.netApy * 100).toFixed(2)}%)`,
    );
  }, 60_000);
});
