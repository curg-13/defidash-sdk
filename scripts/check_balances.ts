/**
 * Check wallet balances and coin objects
 *
 * Shows total balance, individual coin objects, and suggests merging if needed.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  💰 Wallet Balance Check");
  console.log("═══════════════════════════════════════════════════════\n");

  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("❌ Error: SECRET_KEY not found in .env file.");
    return;
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const address = keypair.getPublicKey().toSuiAddress();

  console.log(`👤 Wallet: ${address}\n`);

  // Get SUI balance
  const balance = await suiClient.getBalance({ owner: address });
  const totalSui = Number(balance.totalBalance) / 1e9;

  console.log("📊 SUI Balance:");
  console.log(`   Total: ${totalSui.toFixed(9)} SUI`);
  console.log(`   USD value (@ $1.30): $${(totalSui * 1.3).toFixed(2)}\n`);

  // Get all SUI coin objects
  console.log("🪙  SUI Coin Objects:");
  const coins = await suiClient.getCoins({
    owner: address,
    coinType: "0x2::sui::SUI",
  });

  if (coins.data.length === 0) {
    console.log("   ⚠️  No SUI coins found!\n");
    return;
  }

  console.log(`   Total objects: ${coins.data.length}\n`);

  // Sort by balance descending
  const sortedCoins = coins.data.sort(
    (a, b) => Number(b.balance) - Number(a.balance),
  );

  // Show top 10 largest coins
  const displayCount = Math.min(10, sortedCoins.length);
  console.log(`   Top ${displayCount} largest coins:`);
  sortedCoins.slice(0, displayCount).forEach((coin, i) => {
    const amount = Number(coin.balance) / 1e9;
    console.log(
      `   ${i + 1}. ${amount.toFixed(9)} SUI (ID: ${coin.coinObjectId.slice(0, 8)}...)`,
    );
  });

  if (sortedCoins.length > displayCount) {
    console.log(
      `   ... and ${sortedCoins.length - displayCount} more coin objects\n`,
    );
  } else {
    console.log();
  }

  // Check if merging is recommended
  const largestCoin = Number(sortedCoins[0].balance) / 1e9;
  const needsMerge = coins.data.length > 10 || largestCoin < totalSui * 0.5;

  if (needsMerge) {
    console.log("⚠️  Recommendation:");
    console.log("   Your SUI is fragmented across multiple coin objects.");
    console.log(
      "   Consider merging them to avoid 'InsufficientGas' errors.\n",
    );
    console.log("   To merge all SUI coins:");
    console.log("   npm run script:merge-sui\n");
  } else {
    console.log("✅ Your SUI coins are well consolidated.\n");
  }

  // Check USDC balance
  console.log("─".repeat(55));
  console.log("\n💵 USDC Balance:");
  const usdcBalance = await suiClient.getBalance({
    owner: address,
    coinType:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  });
  const totalUsdc = Number(usdcBalance.totalBalance) / 1e6;
  console.log(`   Total: ${totalUsdc.toFixed(6)} USDC\n`);

  // Get USDC coin objects
  const usdcCoins = await suiClient.getCoins({
    owner: address,
    coinType:
      "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  });

  if (usdcCoins.data.length > 0) {
    console.log(`   Total objects: ${usdcCoins.data.length}`);
    const sortedUsdc = usdcCoins.data.sort(
      (a, b) => Number(b.balance) - Number(a.balance),
    );
    console.log(
      `   Largest coin: ${(Number(sortedUsdc[0].balance) / 1e6).toFixed(6)} USDC\n`,
    );
  }

  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);
