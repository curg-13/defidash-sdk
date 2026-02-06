/**
 * Scallop Unlock Obligation
 *
 * Unlocks a staked obligation so it can be used for leverage operations.
 * Run this BEFORE scallop_leverage_exec if your obligation is locked.
 *
 * Usage: npm run script:scallop-unlock
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Scallop } from "@scallop-io/sui-scallop-sdk";

async function main() {
  console.log("═".repeat(60));
  console.log("  Scallop Unlock Obligation");
  console.log("═".repeat(60));

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
  console.log(`\n📍 Wallet: ${userAddress}`);

  // 2. Initialize Scallop SDK
  console.log(`\n🔄 Initializing Scallop SDK...`);
  const scallop = new Scallop({
    secretKey: secretKey,
    networkType: "mainnet",
  });
  await scallop.init();

  const client = await scallop.createScallopClient();
  const builder = await scallop.createScallopBuilder();

  // 3. Check obligations
  const obligations = await client.getObligations();

  if (obligations.length === 0) {
    console.log(`\n⚠️  No obligations found.`);
    return;
  }

  console.log(`\n📋 Found ${obligations.length} obligation(s):`);

  let hasLocked = false;
  for (const ob of obligations) {
    const status = ob.locked ? "🔒 LOCKED" : "🔓 Unlocked";
    console.log(`   - ${ob.id.slice(0, 20)}... ${status}`);
    if (ob.locked) hasLocked = true;
  }

  if (!hasLocked) {
    console.log(`\n✅ All obligations are already unlocked!`);
    console.log(`   You can now run: npm run script:scallop-leverage-exec`);
    return;
  }

  // 4. Unlock locked obligations
  console.log(`\n🔓 Unlocking obligations...`);

  const tx = builder.createTxBlock();
  tx.setSender(userAddress);

  for (const ob of obligations) {
    if (ob.locked) {
      console.log(`   Unstaking: ${ob.id.slice(0, 20)}...`);
      await tx.unstakeObligationQuick(ob.id, ob.keyId);
    }
  }

  // 5. Execute
  const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });

  console.log(`\n⚠️  Signing and sending transaction...`);
  const result = await builder.signAndSendTxBlock(tx);

  console.log(`\n✅ UNLOCK SUCCESS!`);
  console.log(`📋 Digest: ${result.digest}`);
  console.log(`\n🎉 You can now run: npm run script:scallop-leverage-exec`);

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Done!`);
  console.log("═".repeat(60));
}

main().catch(console.error);
