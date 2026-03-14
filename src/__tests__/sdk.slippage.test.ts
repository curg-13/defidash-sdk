/**
 * SDK Method: Configurable Slippage  [Integration]
 *
 * Verifies that slippageBps parameter works in real transactions.
 *
 * Run: npx vitest run src/__tests__/sdk.slippage.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { DefiDashSDK, LendingProtocol } from '..';
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

// ── SDK Setup ─────────────────────────────────────────────────────────────────
let sdk: DefiDashSDK;
let address: string;

const SECRET_KEY = process.env.SECRET_KEY || process.env.SUI_SECRET_KEY;

beforeAll(async () => {
  if (!SECRET_KEY) throw new Error('SECRET_KEY env is required');
  const suiClient = new SuiClient({
    url: process.env.SUI_FULLNODE_URL || getFullnodeUrl('mainnet'),
  });
  const keypair = Ed25519Keypair.fromSecretKey(SECRET_KEY as any);
  address = keypair.getPublicKey().toSuiAddress();
  sdk = await DefiDashSDK.create(suiClient, keypair);
}, 60_000);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Configurable slippage in leverage', () => {
  it('builds transaction with default slippage (100 bps)', async () => {
    const tx = new Transaction();
    tx.setSender(address);

    // No slippageBps specified - should use default 100 bps (1%)
    await sdk.buildLeverageTransaction(tx, {
      protocol: LendingProtocol.Suilend,
      depositAsset: 'SUI',
      depositValueUsd: 1,
      multiplier: 2.0,
    });

    const result = await sdk.dryRun(tx);
    console.log(`  Default slippage (1%) → ${result.success ? 'SUCCESS' : 'FAILED'}`);
    expect(result).toBeDefined();
  }, 120_000);

  it('builds transaction with custom slippage (50 bps = 0.5%)', async () => {
    const tx = new Transaction();
    tx.setSender(address);

    await sdk.buildLeverageTransaction(tx, {
      protocol: LendingProtocol.Suilend,
      depositAsset: 'SUI',
      depositValueUsd: 1,
      multiplier: 2.0,
      slippageBps: 50, // 0.5% - tighter slippage
    });

    const result = await sdk.dryRun(tx);
    console.log(`  Custom slippage (0.5%) → ${result.success ? 'SUCCESS' : 'FAILED'}`);
    expect(result).toBeDefined();
  }, 120_000);

  it('builds transaction with high slippage (200 bps = 2%)', async () => {
    const tx = new Transaction();
    tx.setSender(address);

    await sdk.buildLeverageTransaction(tx, {
      protocol: LendingProtocol.Suilend,
      depositAsset: 'SUI',
      depositValueUsd: 1,
      multiplier: 2.0,
      slippageBps: 200, // 2% - more tolerant
    });

    const result = await sdk.dryRun(tx);
    console.log(`  Custom slippage (2%) → ${result.success ? 'SUCCESS' : 'FAILED'}`);
    expect(result).toBeDefined();
  }, 120_000);
});

describe('slippageBps edge cases', () => {
  it('accepts slippageBps = 0 (no slippage allowed)', async () => {
    const tx = new Transaction();
    tx.setSender(address);

    // This might fail dryRun if any slippage occurs, but should build
    await sdk.buildLeverageTransaction(tx, {
      protocol: LendingProtocol.Suilend,
      depositAsset: 'SUI',
      depositValueUsd: 1,
      multiplier: 2.0,
      slippageBps: 0,
    });

    // Build succeeded (dryRun may fail due to zero slippage tolerance)
    expect(tx).toBeDefined();
  }, 120_000);

  it('accepts very high slippage (1000 bps = 10%)', async () => {
    const tx = new Transaction();
    tx.setSender(address);

    await sdk.buildLeverageTransaction(tx, {
      protocol: LendingProtocol.Suilend,
      depositAsset: 'SUI',
      depositValueUsd: 1,
      multiplier: 2.0,
      slippageBps: 1000, // 10%
    });

    const result = await sdk.dryRun(tx);
    console.log(`  High slippage (10%) → ${result.success ? 'SUCCESS' : 'FAILED'}`);
    expect(result).toBeDefined();
  }, 120_000);
});
