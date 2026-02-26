/**
 * DefiDash SDK - Preview Leverage Test
 *
 * Tests the previewLeverage method across all protocols.
 * Shows protocol-specific LTV and max multiplier values.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DefiDashSDK, LendingProtocol, LeveragePreview } from "../src";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

const protocols: [LendingProtocol, string][] = [
  [LendingProtocol.Suilend, "Suilend"],
  [LendingProtocol.Navi, "Navi"],
  [LendingProtocol.Scallop, "Scallop"],
];

const testAssets = ["SUI", "LBTC"];

interface PreviewResult {
  protocol: string;
  asset: string;
  success: boolean;
  preview?: LeveragePreview;
  error?: string;
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

async function testPreview(
  sdk: DefiDashSDK,
  protocol: LendingProtocol,
  protocolName: string,
  asset: string,
  multiplier: number,
): Promise<PreviewResult> {
  try {
    const preview = await sdk.previewLeverage({
      protocol,
      depositAsset: asset,
      depositValueUsd: 100, // $100 worth
      multiplier,
    });

    return {
      protocol: protocolName,
      asset,
      success: true,
      preview,
    };
  } catch (error: any) {
    return {
      protocol: protocolName,
      asset,
      success: false,
      error: error.message,
    };
  }
}

function printPreviewTable(results: PreviewResult[]) {
  console.log("\n┌────────────┬───────┬────────┬─────────────┬─────────────┬───────────────┬───────────────┐");
  console.log("│ Protocol   │ Asset │ LTV    │ Max Mult    │ Liq Thresh  │ Liq Price     │ Drop Buffer   │");
  console.log("├────────────┼───────┼────────┼─────────────┼─────────────┼───────────────┼───────────────┤");

  for (const result of results) {
    if (result.success && result.preview) {
      const p = result.preview;
      console.log(
        `│ ${result.protocol.padEnd(10)} │ ${result.asset.padEnd(5)} │ ${formatPercent(p.assetLtv * 100).padStart(6)} │ ${p.maxMultiplier.toFixed(2).padStart(6)}x     │ ${formatPercent(p.liquidationThreshold * 100).padStart(6)}     │ ${formatUsd(p.liquidationPrice).padStart(13)} │ ${formatPercent(p.priceDropBuffer).padStart(13)} │`,
      );
    } else {
      console.log(
        `│ ${result.protocol.padEnd(10)} │ ${result.asset.padEnd(5)} │ ${"ERROR".padStart(6)} │ ${"--".padStart(11)} │ ${"--".padStart(11)} │ ${"--".padStart(13)} │ ${"--".padStart(13)} │`,
      );
    }
  }

  console.log("└────────────┴───────┴────────┴─────────────┴─────────────┴───────────────┴───────────────┘");
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log("  Preview Leverage - Protocol Comparison");
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("Error: SECRET_KEY not found in .env file.");
    return;
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const address = keypair.getPublicKey().toSuiAddress();

  console.log(`Wallet: ${address}\n`);

  // Initialize SDK
  const sdk = new DefiDashSDK({ secretKey });
  await sdk.initialize(suiClient, keypair);
  console.log("SDK initialized.\n");

  // Test multiplier (conservative, should work on all protocols)
  const testMultiplier = 2.0;
  console.log(`Test Parameters:`);
  console.log(`  - Deposit Value: $100`);
  console.log(`  - Multiplier: ${testMultiplier}x\n`);

  const results: PreviewResult[] = [];

  // Test each protocol and asset
  for (const [protocol, protocolName] of protocols) {
    console.log(`Testing ${protocolName}...`);

    for (const asset of testAssets) {
      const result = await testPreview(
        sdk,
        protocol,
        protocolName,
        asset,
        testMultiplier,
      );
      results.push(result);

      if (!result.success) {
        console.log(`  ${asset}: ${result.error}`);
      }
    }
  }

  // Print comparison table
  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log("  Results Summary");
  console.log("═══════════════════════════════════════════════════════════════════════════════");

  printPreviewTable(results);

  // Detailed preview for one successful result
  const successResult = results.find((r) => r.success && r.preview);
  if (successResult?.preview) {
    const p = successResult.preview;
    console.log(`\nDetailed Preview (${successResult.protocol} - ${successResult.asset}):`);
    console.log("─".repeat(50));
    console.log(`  Initial Equity:      ${formatUsd(p.initialEquityUsd)}`);
    console.log(`  Flash Loan (USDC):   ${(Number(p.flashLoanUsdc) / 1e6).toFixed(2)} USDC`);
    console.log(`  Total Position:      ${formatUsd(p.totalPositionUsd)}`);
    console.log(`  Debt:                ${formatUsd(p.debtUsd)}`);
    console.log(`  Position LTV:        ${formatPercent(p.ltvPercent)}`);
    console.log(`  Asset LTV:           ${formatPercent(p.assetLtv * 100)}`);
    console.log(`  Max Multiplier:      ${p.maxMultiplier.toFixed(2)}x`);
    console.log(`  Liq Threshold:       ${formatPercent(p.liquidationThreshold * 100)}`);
    console.log(`  Liquidation Price:   ${formatUsd(p.liquidationPrice)}`);
    console.log(`  Price Drop Buffer:   ${formatPercent(p.priceDropBuffer)}`);
  }

  // Summary
  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log("\n═══════════════════════════════════════════════════════════════════════════════");
  console.log(`  Summary: ${passed} passed, ${failed} failed`);
  console.log("═══════════════════════════════════════════════════════════════════════════════\n");

  if (failed > 0) {
    console.log("Failed tests:");
    results
      .filter((r) => !r.success)
      .forEach((r) => {
        console.log(`  - ${r.protocol} ${r.asset}: ${r.error}`);
      });
  }
}

main().catch(console.error);
