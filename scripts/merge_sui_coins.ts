/**
 * SUI Coin Merge Script
 *
 * Checks all SUI coin objects and merges them into one.
 * Fragmented coins can cause issues with gas estimation.
 *
 * USAGE:
 * - Check only: npm run script:merge-sui
 * - Execute merge: DRY_RUN_ONLY=false npm run script:merge-sui
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

const SUI_TYPE = "0x2::sui::SUI";
const DRY_RUN_ONLY = process.env.DRY_RUN_ONLY !== "false";

async function main() {
  console.log("═".repeat(60));
  console.log(`  SUI Coin Merge - ${DRY_RUN_ONLY ? "CHECK ONLY" : "EXECUTION"}`);
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

  const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });

  // 2. Fetch all SUI coins
  console.log(`\n🔍 Fetching SUI coin objects...`);

  const allCoins: any[] = [];
  let cursor: string | null | undefined = null;

  do {
    const response = await suiClient.getCoins({
      owner: userAddress,
      coinType: SUI_TYPE,
      cursor: cursor,
    });
    allCoins.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor);

  console.log(`\n📊 Found ${allCoins.length} SUI coin objects:`);
  console.log("─".repeat(60));

  let totalBalance = 0n;
  const sortedCoins = allCoins.sort(
    (a, b) => Number(BigInt(b.balance) - BigInt(a.balance))
  );

  for (const coin of sortedCoins) {
    const balance = BigInt(coin.balance);
    totalBalance += balance;
    const suiAmount = Number(balance) / 1e9;
    console.log(
      `  ${coin.coinObjectId.slice(0, 16)}... : ${suiAmount.toFixed(9)} SUI`
    );
  }

  console.log("─".repeat(60));
  console.log(`  Total: ${(Number(totalBalance) / 1e9).toFixed(9)} SUI`);
  console.log(`  Objects: ${allCoins.length}`);

  if (allCoins.length <= 1) {
    console.log(`\n✅ No merge needed - only ${allCoins.length} coin object(s)`);
    return;
  }

  // 3. Merge coins
  console.log(`\n🔧 ${allCoins.length} objects can be merged into 1`);

  if (DRY_RUN_ONLY) {
    console.log(`\n⚠️  DRY RUN - No transaction will be executed`);
    console.log(`   Run with DRY_RUN_ONLY=false to merge coins`);
  } else {
    console.log(`\n🔄 Building merge transaction...`);

    const tx = new Transaction();
    tx.setSender(userAddress);

    // Use the largest coin as the destination
    const primaryCoin = sortedCoins[0];
    const coinsToMerge = sortedCoins.slice(1).map((c) => c.coinObjectId);

    if (coinsToMerge.length > 0) {
      // Merge all other coins into the primary coin
      tx.mergeCoins(
        tx.object(primaryCoin.coinObjectId),
        coinsToMerge.map((id) => tx.object(id))
      );
    }

    console.log(`   Primary coin: ${primaryCoin.coinObjectId.slice(0, 20)}...`);
    console.log(`   Merging ${coinsToMerge.length} coins into primary`);

    // Execute
    console.log(`\n⚠️  Signing and sending transaction...`);

    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: {
        showEffects: true,
      },
    });

    if (result.effects?.status.status === "success") {
      console.log(`\n✅ MERGE SUCCESS!`);
      console.log(`📋 Digest: ${result.digest}`);
      console.log(`\n🎉 ${allCoins.length} coins merged into 1`);
    } else {
      console.log(`\n❌ MERGE FAILED:`);
      console.log(`   Error: ${result.effects?.status.error}`);
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Done!`);
  console.log("═".repeat(60));
}

main().catch(console.error);
