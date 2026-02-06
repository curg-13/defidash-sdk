/**
 * Scallop Get Obligation Script
 *
 * Simple script to check obligation data structure
 *
 * Run with: npm run script:scallop-obligation
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

async function main() {
  console.log("─".repeat(50));
  console.log("  📋 Scallop Get Obligation");
  console.log("─".repeat(50));

  // 1. Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    console.error("❌ SECRET_KEY not found in .env.scripts");
    return;
  }

  let keypair: Ed25519Keypair;
  try {
    if (secretKey.startsWith("suiprivkey")) {
      const decoded = decodeSuiPrivateKey(secretKey);
      keypair = Ed25519Keypair.fromSecretKey(decoded.secretKey);
    } else {
      keypair = Ed25519Keypair.fromSecretKey(Buffer.from(secretKey, "base64"));
    }
  } catch (e) {
    console.error("❌ Failed to parse SECRET_KEY");
    throw e;
  }

  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`\n👤 Wallet: ${userAddress}`);

  // Initialize Scallop SDK
  console.log(`\n🔄 Initializing Scallop SDK...`);
  const scallop = new Scallop({
    secretKey: secretKey,
    networkType: "mainnet",
  });
  await scallop.init();
  const client = await scallop.createScallopClient();

  // Get obligations
  console.log(`\n📋 Getting obligations...`);
  const obligations = await client.getObligations();

  console.log(`\nObligations count: ${obligations.length}`);
  console.log(`\nRaw obligations data:`);
  console.log(JSON.stringify(obligations, null, 2));

  if (obligations.length > 0) {
    const obligation = obligations[0];
    console.log(`\n📋 Querying first obligation: ${obligation.id}`);

    const details = await client.queryObligation(obligation.id);
    console.log(`\nObligation details:`);
    console.log(JSON.stringify(details, null, 2));
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`  ✨ Done!`);
  console.log("─".repeat(50));
}

main().catch(console.error);
