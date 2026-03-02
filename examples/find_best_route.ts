/**
 * DefiDash SDK - Find Best Leverage Route
 *
 * Example: find the best protocol for a leverage position,
 * then dryrun the transaction to verify it works on-chain.
 *
 * Run: npx ts-node examples/find_best_route.ts
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { DefiDashSDK } from "../src";
import { LEVERAGE_MULTIPLIER_BUFFER } from "../src/types";

async function main() {
  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    console.error("SECRET_KEY not found in .env");
    return;
  }

  const suiClient = new SuiClient({
    url: process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet"),
  });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const address = keypair.getPublicKey().toSuiAddress();

  const sdk = await DefiDashSDK.create(suiClient, keypair);

  // ── Step 1: Find best route ──────────────────────────────────────────────
  const route = await sdk.findBestLeverageRoute({
    depositAsset: "SUI",
    depositValueUsd: 1, // small amount for demo
  });

  console.log(`Safe Multiplier: ${route.safeMultiplier.toFixed(2)}x`);
  console.log(
    `  (= min maxMult - ${LEVERAGE_MULTIPLIER_BUFFER} buffer)\n`,
  );

  // Best for max leverage
  console.log(
    `Best Max Multiplier: ${route.bestMaxMultiplier.protocol} ` +
      `(${route.bestMaxMultiplier.preview.maxMultiplier.toFixed(2)}x)`,
  );

  // Best for APY
  const apy = route.bestApy;
  console.log(
    `Best APY:            ${apy.protocol} ` +
      `(${(apy.preview.netApy * 100).toFixed(2)}% net at ${apy.multiplier.toFixed(2)}x)\n`,
  );

  // All protocols comparison
  console.log("All protocols at safe multiplier:");
  for (const { protocol, preview } of route.allPreviews) {
    console.log(
      `  ${protocol.padEnd(8)} → Net APY: ${(preview.netApy * 100).toFixed(2)}%, ` +
        `Max: ${preview.maxMultiplier.toFixed(2)}x`,
    );
  }

  // ── Step 2: Dryrun with best APY route ─────────────────────────────────
  console.log(`\nDryrun: ${apy.protocol} SUI ${apy.multiplier.toFixed(2)}x...`);

  const tx = new Transaction();
  tx.setSender(address);
  await sdk.buildLeverageTransaction(tx, {
    protocol: apy.protocol,
    depositAsset: "SUI",
    depositValueUsd: 1,
    multiplier: apy.multiplier,
  });

  const result = await sdk.dryRun(tx);

  if (result.success) {
    const gas = result.gasUsed
      ? `${(Number(result.gasUsed) / 1e9).toFixed(6)} SUI`
      : "N/A";
    console.log(`Result: SUCCESS (gas: ${gas})`);
  } else {
    console.log(`Result: FAILED — ${result.error}`);
  }
}

main().catch(console.error);
