/**
 * Integration Tests: findBestLeverageRoute
 *
 * Verifies the best-route-finding logic across all protocols:
 *   - Returns two distinct routes (bestMaxMultiplier, bestApy)
 *   - Safe multiplier is correctly calculated
 *   - Graceful degradation when a protocol fails
 *
 * Run: npx vitest run src/__tests__/findBestLeverageRoute.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import {
  DefiDashSDK,
  LendingProtocol,
  LEVERAGE_MULTIPLIER_BUFFER,
} from '..';
import type {
  LeverageRouteResult,
  LeverageRoute,
} from '../types/strategy';

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// ── Print helper ──────────────────────────────────────────────────────────────
function printRouteResult(asset: string, result: LeverageRouteResult): void {
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`;
  const usd = (v: number) => `$${v.toFixed(2)}`;
  console.log(
    [
      `\n┌─ Best Routes for ${asset} ──────────────────────────────────────`,
      `│  Safe Multiplier : ${result.safeMultiplier.toFixed(2)}x`,
      `│  Protocols OK    : ${result.allPreviews.length}`,
      `│  Protocols Failed: ${result.failedProtocols.length}${result.failedProtocols.length > 0 ? ` (${result.failedProtocols.map((f) => f.protocol).join(', ')})` : ''}`,
      `│`,
      `│  ── Best Max Multiplier ──────────────────────────────`,
      `│    Protocol       : ${result.bestMaxMultiplier.protocol}`,
      `│    Max Multiplier : ${result.bestMaxMultiplier.preview.maxMultiplier.toFixed(2)}x`,
      `│    Used Multiplier: ${result.bestMaxMultiplier.multiplier.toFixed(2)}x`,
      `│    Net APY        : ${pct(result.bestMaxMultiplier.preview.netApy)}`,
      `│    Annual Earnings: ${usd(result.bestMaxMultiplier.preview.annualNetEarningsUsd)}`,
      `│`,
      `│  ── Best APY (at safe mult) ──────────────────────────`,
      `│    Protocol       : ${result.bestApy.protocol}`,
      `│    Multiplier     : ${result.bestApy.multiplier.toFixed(2)}x`,
      `│    Net APY        : ${pct(result.bestApy.preview.netApy)}`,
      `│    Annual Earnings: ${usd(result.bestApy.preview.annualNetEarningsUsd)}`,
      `│`,
      `│  ── All Previews (at safe mult) ──────────────────────`,
      ...result.allPreviews.map(
        (p) =>
          `│    ${p.protocol.padEnd(8)} → Net APY: ${pct(p.preview.netApy)}, Max: ${p.preview.maxMultiplier.toFixed(2)}x`,
      ),
      `└──────────────────────────────────────────────────────────────────`,
    ].join('\n'),
  );
}

// ── Shared assertions ─────────────────────────────────────────────────────────
function assertValidRoute(route: LeverageRoute) {
  expect(Object.values(LendingProtocol)).toContain(route.protocol);
  expect(route.multiplier).toBeGreaterThan(1);
  expect(route.preview.maxMultiplier).toBeGreaterThan(1);
  expect(route.preview.initialEquityUsd).toBeGreaterThan(0);
  expect(route.preview.totalPositionUsd).toBeGreaterThan(0);
  expect(route.preview.netApy).toBeDefined();
}

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('findBestLeverageRoute Integration', () => {
  it('SUI $100 – returns two valid routes', async () => {
    const result = await sdk.findBestLeverageRoute({
      depositAsset: 'SUI',
      depositValueUsd: 100,
    });
    printRouteResult('SUI', result);

    assertValidRoute(result.bestMaxMultiplier);
    assertValidRoute(result.bestApy);

    // Safe multiplier = min(maxMults) - buffer
    const minMax = Math.min(
      ...result.allPreviews.map((p) => p.preview.maxMultiplier),
    );
    expect(result.safeMultiplier).toBeCloseTo(
      Math.max(1.1, minMax - LEVERAGE_MULTIPLIER_BUFFER),
      1,
    );

    // bestMaxMultiplier should have the highest maxMultiplier
    for (const p of result.allPreviews) {
      expect(result.bestMaxMultiplier.preview.maxMultiplier).toBeGreaterThanOrEqual(
        p.preview.maxMultiplier,
      );
    }

    // bestApy should have the highest netApy among all safe previews
    for (const p of result.allPreviews) {
      expect(result.bestApy.preview.netApy).toBeGreaterThanOrEqual(
        p.preview.netApy,
      );
    }
  }, 120_000);

  it('XBTC $100 – valid routes for BTC leverage', async () => {
    const result = await sdk.findBestLeverageRoute({
      depositAsset: 'XBTC',
      depositValueUsd: 100,
    });
    printRouteResult('XBTC', result);

    assertValidRoute(result.bestMaxMultiplier);
    assertValidRoute(result.bestApy);

    // At least 2 protocols should succeed for XBTC
    expect(result.allPreviews.length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('bestApy multiplier equals safeMultiplier', async () => {
    const result = await sdk.findBestLeverageRoute({
      depositAsset: 'SUI',
      depositValueUsd: 100,
    });

    expect(result.bestApy.multiplier).toBe(result.safeMultiplier);
  }, 120_000);

  // ── Dryrun: verify best APY route builds a valid transaction on-chain ──────
  it('SUI $1 – dryrun leverage with best APY route succeeds', async () => {
    const route = await sdk.findBestLeverageRoute({
      depositAsset: 'SUI',
      depositValueUsd: 1,
    });

    const result = await sdk.leverage({
      protocol: route.bestApy.protocol,
      depositAsset: 'SUI',
      depositValueUsd: 1,
      multiplier: route.bestApy.multiplier,
      dryRun: true,
    });

    console.log(
      `\n  Dryrun: ${route.bestApy.protocol} SUI ${route.bestApy.multiplier.toFixed(2)}x → ` +
        `${result.success ? 'SUCCESS' : 'FAILED: ' + result.error}` +
        `${result.gasUsed ? ` (gas: ${(Number(result.gasUsed) / 1e9).toFixed(4)} SUI)` : ''}`,
    );

    expect(result.success).toBe(true);
    expect(result.gasUsed).toBeDefined();
    expect(result.gasUsed).toBeGreaterThan(0n);
  }, 180_000);

  // ── Error cases ──────────────────────────────────────────────────────────────
  it('rejects when neither depositAmount nor depositValueUsd provided', async () => {
    await expect(
      sdk.findBestLeverageRoute({ depositAsset: 'SUI' }),
    ).rejects.toThrow('Either depositAmount or depositValueUsd must be provided');
  });

  it('rejects unknown asset', async () => {
    await expect(
      sdk.findBestLeverageRoute({
        depositAsset: 'FAKECOIN',
        depositValueUsd: 100,
      }),
    ).rejects.toThrow();
  });
});
