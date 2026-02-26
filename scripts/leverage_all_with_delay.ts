/**
 * Leverage all protocols with delay
 */
import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DefiDashSDK, LendingProtocol } from "../src";

const protocols: [LendingProtocol, string][] = [
  [LendingProtocol.Suilend, "Suilend"],
  [LendingProtocol.Navi, "Navi"],
  [LendingProtocol.Scallop, "Scallop"],
];

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Leverage All Protocols ($1 SUI each, 10s delay) ===\n");

  const secretKey = process.env.SECRET_KEY!;
  const suiClient = new SuiClient({
    url: process.env.SUI_FULLNODE_URL || "https://fullnode.mainnet.sui.io",
  });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);

  console.log(`Wallet: ${keypair.getPublicKey().toSuiAddress()}\n`);

  const sdk = new DefiDashSDK({ secretKey });
  await sdk.initialize(suiClient, keypair);
  console.log("SDK initialized.\n");

  const results: { protocol: string; success: boolean; tx?: string; error?: string }[] = [];

  for (let i = 0; i < protocols.length; i++) {
    const [protocol, name] = protocols[i];
    console.log(`▶ ${name} - Leverage $1 SUI at 2x...`);

    try {
      const result = await sdk.leverage({
        protocol,
        depositAsset: "SUI",
        depositValueUsd: 1.0,
        multiplier: 2.0,
        dryRun: false,
      });

      if (result.success) {
        console.log(`  ✅ TX: ${result.txDigest}`);
        console.log(`  ⛽ Gas: ${Number(result.gasUsed) / 1e9} SUI\n`);
        results.push({ protocol: name, success: true, tx: result.txDigest });
      } else {
        console.log(`  ❌ Failed: ${result.error}\n`);
        results.push({ protocol: name, success: false, error: result.error });
      }
    } catch (e: any) {
      console.log(`  ❌ Error: ${e.message}\n`);
      results.push({ protocol: name, success: false, error: e.message });
    }

    // Wait 10 seconds before next protocol (except last)
    if (i < protocols.length - 1) {
      console.log("  ⏳ Waiting 10 seconds...\n");
      await sleep(10000);
    }
  }

  // Summary
  console.log("\n=== Summary ===");
  const passed = results.filter((r) => r.success).length;
  console.log(`Passed: ${passed}/${protocols.length}`);
  results.forEach((r) => {
    if (r.success) {
      console.log(`  ✅ ${r.protocol}: ${r.tx}`);
    } else {
      console.log(`  ❌ ${r.protocol}: ${r.error}`);
    }
  });
}

main().catch(console.error);
