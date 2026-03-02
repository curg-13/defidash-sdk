/**
 * Test all protocols - Full E2E Cycle
 *
 * Flow:
 *   1. Preview & Best Route
 *   2. Leverage (all protocols)
 *   3. Portfolio query (getAggregatedPortfolio + getOpenPositions)
 *   4. Deleverage (all protocols)
 *
 * Usage:
 *   npx tsx scripts/test_all_protocols.ts                  # dryrun full cycle
 *   npx tsx scripts/test_all_protocols.ts --execute         # execute full cycle
 *   npx tsx scripts/test_all_protocols.ts --leverage-only   # leverage only
 *   npx tsx scripts/test_all_protocols.ts --deleverage-only # deleverage only
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { DefiDashSDK, LendingProtocol } from '../src';

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl('mainnet');

const protocols: [LendingProtocol, string][] = [
  [LendingProtocol.Suilend, 'Suilend'],
  [LendingProtocol.Navi, 'Navi'],
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

// ── Step 1: Preview & Best Route ─────────────────────────────────────────────

async function testPreviewAndRoute(sdk: DefiDashSDK): Promise<TestResult[]> {
  const results: TestResult[] = [];

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║  Step 1: Preview & Best Route                        ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  // Preview for each protocol
  for (const [protocol, name] of protocols) {
    try {
      console.log(`\n  ▶ Preview ${name} XBTC 2x...`);
      const preview = await sdk.previewLeverage({
        protocol,
        depositAsset: 'XBTC',
        depositValueUsd: 1.0,
        multiplier: 2.0,
      });

      console.log(`    Equity: $${preview.initialEquityUsd.toFixed(2)}`);
      console.log(
        `    Total Position: $${preview.totalPositionUsd.toFixed(2)}`,
      );
      console.log(
        `    Flash Loan: ${(Number(preview.flashLoanUsdc) / 1e6).toFixed(2)} USDC`,
      );
      console.log(`    LTV: ${preview.ltvPercent.toFixed(1)}%`);
      console.log(`    Max Multiplier: ${preview.maxMultiplier.toFixed(2)}x`);
      console.log(
        `    Liquidation Price: $${preview.liquidationPrice.toFixed(2)}`,
      );
      console.log(
        `    Price Drop Buffer: ${preview.priceDropBuffer.toFixed(1)}%`,
      );
      console.log(`  ✅ Preview OK`);

      results.push({ protocol: name, action: 'preview', success: true });
    } catch (error: any) {
      console.log(`  ❌ Preview Failed: ${error.message}`);
      results.push({
        protocol: name,
        action: 'preview',
        success: false,
        error: error.message,
      });
    }
  }

  // Best route
  try {
    console.log(`\n  ▶ Find Best Route (XBTC $1)...`);
    const route = await sdk.findBestLeverageRoute({
      depositAsset: 'XBTC',
      depositValueUsd: 1.0,
    });

    console.log(`    Safe Multiplier: ${route.safeMultiplier.toFixed(2)}x`);
    console.log(
      `    Best Max Multiplier: ${route.bestMaxMultiplier.protocol} (${route.bestMaxMultiplier.preview.maxMultiplier.toFixed(2)}x)`,
    );
    console.log(
      `    Best APY: ${route.bestApy.protocol} (${(route.bestApy.preview.netApy * 100).toFixed(2)}%)`,
    );
    console.log(`  ✅ Best Route OK`);

    results.push({ protocol: 'ALL', action: 'bestRoute', success: true });
  } catch (error: any) {
    console.log(`  ❌ Best Route Failed: ${error.message}`);
    results.push({
      protocol: 'ALL',
      action: 'bestRoute',
      success: false,
      error: error.message,
    });
  }

  return results;
}

// ── Step 2: Leverage ─────────────────────────────────────────────────────────

async function testLeverage(
  sdk: DefiDashSDK,
  protocol: LendingProtocol,
  protocolName: string,
  dryRun: boolean,
  address: string,
): Promise<TestResult> {
  try {
    const tx = new Transaction();
    tx.setSender(address);
    await sdk.buildLeverageTransaction(tx, {
      protocol,
      depositAsset: 'XBTC',
      depositValueUsd: 1.0,
      multiplier: 2.0,
    });

    const result = dryRun ? await sdk.dryRun(tx) : await sdk.execute(tx);

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

// ── Step 3: Portfolio Query ──────────────────────────────────────────────────

async function testPortfolioQuery(sdk: DefiDashSDK): Promise<TestResult[]> {
  const results: TestResult[] = [];

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║  Step 3: Portfolio & Position Query                   ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  // getOpenPositions
  try {
    console.log(`\n  ▶ getOpenPositions()...`);
    const positions = await sdk.getOpenPositions();

    if (positions.length === 0) {
      console.log(`    (no open positions)`);
    }
    for (const { protocol, position } of positions) {
      const supplies = position.supplies
        .map((s) => `${s.symbol} $${s.valueUsd.toFixed(2)}`)
        .join(', ');
      const borrows = position.borrows
        .map((b) => `${b.symbol} $${b.valueUsd.toFixed(2)}`)
        .join(', ');
      console.log(`    [${protocol}]`);
      console.log(`      Supplies: ${supplies || '(none)'}`);
      console.log(`      Borrows:  ${borrows || '(none)'}`);
      console.log(`      Net: $${position.netValueUsd.toFixed(4)}`);
    }
    console.log(`  ✅ ${positions.length} open position(s) found`);

    results.push({
      protocol: 'ALL',
      action: 'getOpenPositions',
      success: true,
    });
  } catch (error: any) {
    console.log(`  ❌ getOpenPositions Failed: ${error.message}`);
    results.push({
      protocol: 'ALL',
      action: 'getOpenPositions',
      success: false,
      error: error.message,
    });
  }

  // getAggregatedPortfolio
  try {
    console.log(`\n  ▶ getAggregatedPortfolio()...`);
    const portfolios = await sdk.getAggregatedPortfolio();

    for (const p of portfolios) {
      const hf = p.healthFactor === Infinity ? '∞' : p.healthFactor.toFixed(2);
      const apy =
        p.netApy != null ? ` | APY: ${(p.netApy * 100).toFixed(2)}%` : '';
      console.log(
        `    [${p.protocol}] Net: $${p.netValueUsd.toFixed(4)} | HF: ${hf} | ` +
          `Collateral: $${p.totalCollateralUsd.toFixed(4)} | Debt: $${p.totalDebtUsd.toFixed(4)}${apy}`,
      );
      if (p.positions.length > 0) {
        for (const pos of p.positions) {
          console.log(
            `      ${pos.side.padEnd(7)} ${pos.symbol.padEnd(10)} $${pos.valueUsd.toFixed(4)} (APY: ${(pos.apy * 100).toFixed(2)}%)`,
          );
        }
      }
    }
    console.log(`  ✅ Portfolio OK`);

    results.push({
      protocol: 'ALL',
      action: 'getAggregatedPortfolio',
      success: true,
    });
  } catch (error: any) {
    console.log(`  ❌ getAggregatedPortfolio Failed: ${error.message}`);
    results.push({
      protocol: 'ALL',
      action: 'getAggregatedPortfolio',
      success: false,
      error: error.message,
    });
  }

  return results;
}

// ── Step 4: Deleverage ───────────────────────────────────────────────────────

async function testDeleverage(
  sdk: DefiDashSDK,
  protocol: LendingProtocol,
  protocolName: string,
  dryRun: boolean,
  address: string,
): Promise<TestResult> {
  try {
    const tx = new Transaction();
    tx.setSender(address);
    await sdk.buildDeleverageTransaction(tx, { protocol });

    const result = dryRun ? await sdk.dryRun(tx) : await sdk.execute(tx);

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

// ── Main ─────────────────────────────────────────────────────────────────────

function printResult(result: TestResult): void {
  if (result.success) {
    console.log(`  ✅ ${result.protocol} ${result.action}`);
    if (result.txDigest) console.log(`     TX: ${result.txDigest}`);
    if (result.gasUsed)
      console.log(`     Gas: ${(Number(result.gasUsed) / 1e9).toFixed(4)} SUI`);
  } else {
    console.log(`  ❌ ${result.protocol} ${result.action}: ${result.error}`);
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Full E2E Test: Preview → Leverage → Portfolio → Deleverage');
  console.log('═══════════════════════════════════════════════════════\n');

  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const leverageOnly = args.includes('--leverage-only');
  const deleverageOnly = args.includes('--deleverage-only');

  console.log(`Mode: ${dryRun ? '🧪 DRY RUN' : '⚠️  EXECUTION'}`);
  console.log(
    `Tests: ${leverageOnly ? 'Leverage only' : deleverageOnly ? 'Deleverage only' : 'Full cycle'}\n`,
  );

  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === 'YOUR_SECRET_KEY_HERE') {
    console.error('❌ Error: SECRET_KEY not found in .env file.');
    return;
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const address = keypair.getPublicKey().toSuiAddress();

  console.log(`👤 Wallet: ${address}\n`);

  const sdk = await DefiDashSDK.create(suiClient, keypair);
  const allResults: TestResult[] = [];

  // ── Step 1: Preview & Best Route ──────────────────────────────────────
  if (!deleverageOnly) {
    const previewResults = await testPreviewAndRoute(sdk);
    allResults.push(...previewResults);
  }

  // ── Step 2: Leverage ──────────────────────────────────────────────────
  if (!deleverageOnly) {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log(
      `║  Step 2: Leverage (${dryRun ? 'DRY RUN' : 'EXECUTE'})                            ║`,
    );
    console.log('╚═══════════════════════════════════════════════════════╝');

    for (const [protocol, name] of protocols) {
      console.log(`\n  ▶ ${name} - Leverage...`);
      const result = await testLeverage(sdk, protocol, name, dryRun, address);
      allResults.push(result);
      printResult(result);

      if (!dryRun && result.success) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  // ── Step 3: Portfolio Query ───────────────────────────────────────────
  // Wait for on-chain state to settle after leverage executions
  if (!dryRun && !deleverageOnly) {
    console.log('\n  ⏳ Waiting for on-chain state to settle...');
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const portfolioResults = await testPortfolioQuery(sdk);
  allResults.push(...portfolioResults);

  // ── Step 4: Deleverage ────────────────────────────────────────────────
  if (!leverageOnly) {
    console.log('\n╔═══════════════════════════════════════════════════════╗');
    console.log(
      `║  Step 4: Deleverage (${dryRun ? 'DRY RUN' : 'EXECUTE'})                          ║`,
    );
    console.log('╚═══════════════════════════════════════════════════════╝');

    for (const [protocol, name] of protocols) {
      console.log(`\n  ▶ ${name} - Deleverage...`);
      const result = await testDeleverage(sdk, protocol, name, dryRun, address);
      allResults.push(result);
      printResult(result);

      // Wait between deleverage TXs to avoid shared object congestion
      // and stale object version references
      if (!dryRun && result.success) {
        console.log('  ⏳ Waiting 3s for on-chain finality...');
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  📊 Test Summary');
  console.log('═══════════════════════════════════════════════════════\n');

  const passed = allResults.filter((r) => r.success).length;
  const failed = allResults.filter((r) => !r.success).length;

  console.log(`  Total: ${allResults.length}`);
  console.log(`  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}\n`);

  if (failed > 0) {
    console.log('  Failed tests:');
    allResults
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`    • ${r.protocol} ${r.action}: ${r.error}`);
      });
    console.log();
  }

  console.log('═══════════════════════════════════════════════════════\n');
}

main().catch(console.error);
