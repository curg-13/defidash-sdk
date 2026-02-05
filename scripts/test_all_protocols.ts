/**
 * Test all protocols - Leverage & Deleverage
 *
 * Tests all three protocols (Suilend, Navi, Scallop) with dryrun by default.
 * Does not modify .env file.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DefiDashSDK, LendingProtocol } from '../src';

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl('mainnet');

const protocols: [LendingProtocol, string][] = [
  // [LendingProtocol.Suilend, 'Suilend'],
  // [LendingProtocol.Navi, 'Navi'],
  [LendingProtocol.Scallop, 'Scallop'],
];

interface TestResult {
  protocol: string;
  action: string;
  success: boolean;
  error?: string;
  gasUsed?: bigint;
  txDigest?: string;
}

async function testLeverage(
  sdk: DefiDashSDK,
  protocol: LendingProtocol,
  protocolName: string,
  dryRun: boolean,
): Promise<TestResult> {
  try {
    const result = await sdk.leverage({
      protocol,
      depositAsset: 'SUI',
      depositValueUsd: 1.0,
      multiplier: 2.0,
      dryRun,
    });

    if (result.success) {
      return {
        protocol: protocolName,
        action: 'leverage',
        success: true,
        gasUsed: result.gasUsed,
        txDigest: result.txDigest,
      };
    } else {
      return {
        protocol: protocolName,
        action: 'leverage',
        success: false,
        error: result.error,
      };
    }
  } catch (error: any) {
    return {
      protocol: protocolName,
      action: 'leverage',
      success: false,
      error: error.message,
    };
  }
}

async function testDeleverage(
  sdk: DefiDashSDK,
  protocol: LendingProtocol,
  protocolName: string,
  dryRun: boolean,
): Promise<TestResult> {
  try {
    // Check if position exists first
    const position = await sdk.getPosition(protocol);
    if (!position || position.debt.amount === 0n) {
      return {
        protocol: protocolName,
        action: 'deleverage',
        success: false,
        error: 'No position found or no debt to repay',
      };
    }

    const result = await sdk.deleverage({
      protocol,
      dryRun,
    });

    if (result.success) {
      return {
        protocol: protocolName,
        action: 'deleverage',
        success: true,
        gasUsed: result.gasUsed,
        txDigest: result.txDigest,
      };
    } else {
      return {
        protocol: protocolName,
        action: 'deleverage',
        success: false,
        error: result.error,
      };
    }
  } catch (error: any) {
    return {
      protocol: protocolName,
      action: 'deleverage',
      success: false,
      error: error.message,
    };
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  🧪 Testing All Protocols - Leverage & Deleverage');
  console.log('═══════════════════════════════════════════════════════\n');

  // Parse command line args
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const testLeverageOnly = args.includes('--leverage-only');
  const testDeleverageOnly = args.includes('--deleverage-only');

  console.log(`Mode: ${dryRun ? '🧪 DRY RUN' : '⚠️  EXECUTION'}`);
  console.log(
    `Tests: ${testLeverageOnly ? 'Leverage only' : testDeleverageOnly ? 'Deleverage only' : 'Full cycle'}\n`,
  );

  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === 'YOUR_SECRET_KEY_HERE') {
    console.error('❌ Error: SECRET_KEY not found in .env file.');
    return;
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const address = keypair.getPublicKey().toSuiAddress();

  console.log(`👤 Wallet: ${address}\n`);

  // Initialize SDK (with secretKey for Scallop support)
  const sdk = new DefiDashSDK({ secretKey });
  await sdk.initialize(suiClient, keypair);

  const results: TestResult[] = [];

  // Test each protocol
  for (const [protocol, name] of protocols) {
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  Testing ${name}`);
    console.log(`${'─'.repeat(55)}`);

    // Test Leverage
    if (!testDeleverageOnly) {
      console.log(`\n  ▶ ${name} - Leverage...`);
      const leverageResult = await testLeverage(sdk, protocol, name, dryRun);
      results.push(leverageResult);

      if (leverageResult.success) {
        console.log(`  ✅ Success`);
        if (leverageResult.txDigest) {
          console.log(`     TX: ${leverageResult.txDigest}`);
        }
        if (leverageResult.gasUsed) {
          console.log(`     Gas: ${Number(leverageResult.gasUsed) / 1e9} SUI`);
        }
      } else {
        console.log(`  ❌ Failed: ${leverageResult.error}`);
      }

      // Wait a bit between operations
      if (!dryRun && leverageResult.success) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Test Deleverage
    if (!testLeverageOnly) {
      console.log(`\n  ▶ ${name} - Deleverage...`);
      const deleverageResult = await testDeleverage(
        sdk,
        protocol,
        name,
        dryRun,
      );
      results.push(deleverageResult);

      if (deleverageResult.success) {
        console.log(`  ✅ Success`);
        if (deleverageResult.txDigest) {
          console.log(`     TX: ${deleverageResult.txDigest}`);
        }
        if (deleverageResult.gasUsed) {
          console.log(
            `     Gas: ${Number(deleverageResult.gasUsed) / 1e9} SUI`,
          );
        }
      } else {
        console.log(`  ❌ Failed: ${deleverageResult.error}`);
      }
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  📊 Test Summary');
  console.log('═══════════════════════════════════════════════════════\n');

  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(`  Total: ${results.length}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}\n`);

  // Detailed results
  if (failed > 0) {
    console.log('  Failed tests:');
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`    • ${r.protocol} ${r.action}: ${r.error}`);
      });
    console.log();
  }

  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(console.error);
