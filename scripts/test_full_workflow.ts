/**
 * Test Full Workflow - Preview → Leverage → Portfolio → Deleverage
 *
 * Tests complete leverage/deleverage cycle for all protocols.
 * Default: dryrun mode. Use --execute for real transactions.
 */

import * as dotenv from 'dotenv';
dotenv.config({ path: '.env' });

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { DefiDashSDK, LendingProtocol } from '../src';

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl('mainnet');

const protocols: [LendingProtocol, string][] = [
  [LendingProtocol.Suilend, 'Suilend'],
  [LendingProtocol.Navi, 'Navi'],
  [LendingProtocol.Scallop, 'Scallop'],
];

interface WorkflowResult {
  protocol: string;
  preview: { success: boolean; maxMultiplier?: number; error?: string };
  leverage: { success: boolean; tx?: string; gas?: number; error?: string };
  portfolio: {
    success: boolean;
    deposited?: number;
    debt?: number;
    health?: number;
    error?: string;
  };
  deleverage: { success: boolean; tx?: string; gas?: number; error?: string };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testProtocolWorkflow(
  sdk: DefiDashSDK,
  protocol: LendingProtocol,
  protocolName: string,
  dryRun: boolean,
  address: string,
): Promise<WorkflowResult> {
  const result: WorkflowResult = {
    protocol: protocolName,
    preview: { success: false },
    leverage: { success: false },
    portfolio: { success: false },
    deleverage: { success: false },
  };

  // 1. Preview
  console.log(`\n  1️⃣  Preview...`);
  try {
    const preview = await sdk.previewLeverage({
      protocol,
      depositAsset: 'SUI',
      depositValueUsd: 1.0,
      multiplier: 2.0,
    });
    result.preview = {
      success: true,
      maxMultiplier: preview.maxMultiplier,
    };
    console.log(
      `     ✅ LTV: ${(preview.assetLtv * 100).toFixed(0)}%, Max: ${preview.maxMultiplier.toFixed(2)}x`,
    );
  } catch (e: any) {
    result.preview = { success: false, error: e.message };
    console.log(`     ❌ ${e.message}`);
  }

  // 2. Leverage
  console.log(`\n  2️⃣  Leverage ($1 SUI @ 2x)...`);
  try {
    const leverageResult = await sdk.leverage({
      protocol,
      depositAsset: 'SUI',
      depositValueUsd: 1.0,
      multiplier: 2.0,
      dryRun,
    });

    if (leverageResult.success) {
      result.leverage = {
        success: true,
        tx: leverageResult.txDigest,
        gas: Number(leverageResult.gasUsed) / 1e9,
      };
      console.log(`     ✅ TX: ${leverageResult.txDigest?.slice(0, 12)}...`);
      console.log(`     ⛽ Gas: ${result.leverage.gas?.toFixed(4)} SUI`);
    } else {
      result.leverage = { success: false, error: leverageResult.error };
      console.log(`     ❌ ${leverageResult.error}`);
    }
  } catch (e: any) {
    result.leverage = { success: false, error: e.message };
    console.log(`     ❌ ${e.message}`);
  }

  // Wait before portfolio check
  if (!dryRun && result.leverage.success) {
    console.log(`\n     ⏳ Waiting 3s for chain sync...`);
    await sleep(3000);
  }

  // 3. Portfolio Check
  console.log(`\n  3️⃣  Portfolio Check...`);
  try {
    const adapter = (sdk as any).protocols.get(protocol);
    const portfolio = await adapter.getAccountPortfolio(address);

    result.portfolio = {
      success: true,
      deposited: portfolio.totalDepositedUsd || 0,
      debt: portfolio.totalDebtUsd || 0,
      health: portfolio.healthFactor,
    };

    if (portfolio.totalDebtUsd > 0) {
      console.log(
        `     ✅ Deposited: $${portfolio.totalDepositedUsd?.toFixed(2)}`,
      );
      console.log(`     ✅ Debt: $${portfolio.totalDebtUsd.toFixed(2)}`);
      console.log(
        `     ✅ Health: ${portfolio.healthFactor === Infinity ? 'Safe' : portfolio.healthFactor?.toFixed(2)}`,
      );
    } else {
      console.log(`     ℹ️  No active position (dryrun or no execution)`);
    }
  } catch (e: any) {
    result.portfolio = { success: false, error: e.message };
    console.log(`     ❌ ${e.message}`);
  }

  // 4. Deleverage
  console.log(`\n  4️⃣  Deleverage...`);
  try {
    // Check if there's a position to deleverage
    const position = await sdk.getPosition(protocol);
    if (!position || position.debt.amount === 0n) {
      result.deleverage = {
        success: false,
        error: 'No position to deleverage',
      };
      console.log(`     ⏭️  Skipped (no position)`);
    } else {
      const deleverageResult = await sdk.deleverage({
        protocol,
        dryRun,
      });

      if (deleverageResult.success) {
        result.deleverage = {
          success: true,
          tx: deleverageResult.txDigest,
          gas: Number(deleverageResult.gasUsed) / 1e9,
        };
        console.log(
          `     ✅ TX: ${deleverageResult.txDigest?.slice(0, 12)}...`,
        );
        console.log(`     ⛽ Gas: ${result.deleverage.gas?.toFixed(4)} SUI`);
      } else {
        result.deleverage = { success: false, error: deleverageResult.error };
        console.log(`     ❌ ${deleverageResult.error}`);
      }
    }
  } catch (e: any) {
    result.deleverage = { success: false, error: e.message };
    console.log(`     ❌ ${e.message}`);
  }

  return result;
}

function printSummaryTable(results: WorkflowResult[]) {
  console.log(
    '\n┌────────────┬──────────┬──────────┬────────────┬────────────┐',
  );
  console.log('│ Protocol   │ Preview  │ Leverage │ Portfolio  │ Deleverage │');
  console.log('├────────────┼──────────┼──────────┼────────────┼────────────┤');

  for (const r of results) {
    const preview = r.preview.success ? '✅' : '❌';
    const leverage = r.leverage.success ? '✅' : '❌';
    const portfolio = r.portfolio.success ? '✅' : '❌';
    const deleverage = r.deleverage.success
      ? '✅'
      : r.deleverage.error?.includes('No position')
        ? '⏭️'
        : '❌';

    console.log(
      `│ ${r.protocol.padEnd(10)} │    ${preview}    │    ${leverage}    │     ${portfolio}     │     ${deleverage}     │`,
    );
  }

  console.log('└────────────┴──────────┴──────────┴────────────┴────────────┘');
}

async function main() {
  console.log(
    '═══════════════════════════════════════════════════════════════',
  );
  console.log(
    '  Full Workflow Test: Preview → Leverage → Portfolio → Deleverage',
  );
  console.log(
    '═══════════════════════════════════════════════════════════════\n',
  );

  // Parse args
  const args = process.argv.slice(2);
  const dryRun = !args.includes('--execute');
  const delaySeconds = parseInt(
    args.find((a) => a.startsWith('--delay='))?.split('=')[1] || '10',
  );

  console.log(`Mode: ${dryRun ? '🧪 DRY RUN' : '⚠️  EXECUTION'}`);
  console.log(`Delay between protocols: ${delaySeconds}s\n`);

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

  // Initialize SDK
  const sdk = new DefiDashSDK({ secretKey });
  await sdk.initialize(suiClient, keypair);
  console.log('📦 SDK initialized.\n');

  const results: WorkflowResult[] = [];

  // Test each protocol
  for (let i = 0; i < protocols.length; i++) {
    const [protocol, name] = protocols[i];

    console.log('─'.repeat(63));
    console.log(`  Testing ${name}`);
    console.log('─'.repeat(63));

    const result = await testProtocolWorkflow(
      sdk,
      protocol,
      name,
      dryRun,
      address,
    );
    results.push(result);

    // Delay between protocols
    if (i < protocols.length - 1) {
      console.log(`\n  ⏳ Waiting ${delaySeconds}s before next protocol...\n`);
      await sleep(delaySeconds * 1000);
    }
  }

  // Summary
  console.log(
    '\n═══════════════════════════════════════════════════════════════',
  );
  console.log('  Summary');
  console.log(
    '═══════════════════════════════════════════════════════════════',
  );

  printSummaryTable(results);

  // Count results
  const previewPassed = results.filter((r) => r.preview.success).length;
  const leveragePassed = results.filter((r) => r.leverage.success).length;
  const portfolioPassed = results.filter((r) => r.portfolio.success).length;
  const deleveragePassed = results.filter((r) => r.deleverage.success).length;

  console.log(
    `\nPreview: ${previewPassed}/${protocols.length} | Leverage: ${leveragePassed}/${protocols.length} | Portfolio: ${portfolioPassed}/${protocols.length} | Deleverage: ${deleveragePassed}/${protocols.length}`,
  );

  // Show errors if any
  const errors = results.filter(
    (r) =>
      !r.preview.success ||
      !r.leverage.success ||
      (!r.deleverage.success && !r.deleverage.error?.includes('No position')),
  );

  if (errors.length > 0) {
    console.log('\nErrors:');
    for (const r of errors) {
      if (!r.preview.success)
        console.log(`  • ${r.protocol} preview: ${r.preview.error}`);
      if (!r.leverage.success)
        console.log(`  • ${r.protocol} leverage: ${r.leverage.error}`);
      if (
        !r.deleverage.success &&
        !r.deleverage.error?.includes('No position')
      ) {
        console.log(`  • ${r.protocol} deleverage: ${r.deleverage.error}`);
      }
    }
  }

  console.log(
    '\n═══════════════════════════════════════════════════════════════\n',
  );
}

main().catch(console.error);
