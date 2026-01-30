/**
 * Scallop Deposit Script
 *
 * Deposits collateral into Scallop using native SDK.
 * Similar structure to suilend_deposit.ts
 *
 * Run with: npm run script:scallop-deposit
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { getTokenPrice } from "@7kprotocol/sdk-ts";
import { normalizeCoinType, formatUnits } from "../../src/utils";
import { getReserveByCoinType } from "../../src/lib/suilend/const";

// Config from environment
const SUI_COIN_TYPE = "0x2::sui::SUI";
const DEPOSIT_COIN_TYPE = process.env.DEPOSIT_COIN_TYPE || SUI_COIN_TYPE;
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT || "1000000000"; // 1 SUI in raw
const DEPOSIT_THRESHOLD = Number(process.env.DEPOSIT_THRESHOLD) || 0;

// Coin type to Scallop name mapping
const COIN_NAME_MAP: Record<string, string> = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI":
    "sui",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    "usdc",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN":
    "wusdc",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN":
    "wusdt",
};

function getCoinName(coinType: string): string {
  const normalized = normalizeCoinType(coinType);
  return COIN_NAME_MAP[normalized] || "sui";
}

async function main() {
  console.log("─".repeat(50));
  console.log("  📦 Scallop Deposit Script");
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

  const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });

  // Initialize Scallop SDK with secretKey
  console.log(`\n🔄 Initializing Scallop SDK...`);
  const scallop = new Scallop({
    secretKey: secretKey,
    networkType: "mainnet",
  });
  await scallop.init();
  const client = await scallop.createScallopClient();

  // 2. Get asset info
  const normalizedDepositCoin = normalizeCoinType(DEPOSIT_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedDepositCoin);
  const decimals = reserve?.decimals || 9;
  const symbol = reserve?.symbol || "SUI";
  const coinName = getCoinName(DEPOSIT_COIN_TYPE);

  // 3. Show relevant balances
  const balances = await suiClient.getAllBalances({ owner: userAddress });
  console.log(`\n💰 Balances:`);
  balances.forEach((b) => {
    const normalizedB = normalizeCoinType(b.coinType);
    if (normalizedB === normalizedDepositCoin) {
      console.log(
        `  • ${symbol}: ${formatUnits(b.totalBalance, decimals)} (Raw: ${b.totalBalance})`,
      );
    } else if (b.coinType === SUI_COIN_TYPE) {
      console.log(`  • SUI: ${formatUnits(b.totalBalance, 9)}`);
    }
  });

  try {
    // 4. Check existing obligations
    const obligations = await client.getObligations();
    console.log(`\n📋 Obligations found: ${obligations.length}`);

    if (obligations.length > 0) {
      console.log(`   First obligation: ${obligations[0].id.slice(0, 20)}...`);
    }

    // 5. Get price and show deposit info
    const assetPrice = await getTokenPrice(normalizedDepositCoin);
    const humanAmount = Number(DEPOSIT_AMOUNT) / Math.pow(10, decimals);
    const usdValue = humanAmount * assetPrice;

    console.log(`\n📊 Deposit Info:`);
    console.log("─".repeat(45));
    console.log(`  Asset:       ${symbol} (${coinName})`);
    console.log(
      `  Amount:      ${formatUnits(DEPOSIT_AMOUNT, decimals)} ${symbol} (Raw: ${DEPOSIT_AMOUNT})`,
    );
    console.log(`  Price:       $${assetPrice.toLocaleString()}`);
    console.log(`  USD Value:   ~$${usdValue.toFixed(2)}`);
    console.log("─".repeat(45));

    // 6. Check existing collateral
    let existingCollateral = 0;
    if (obligations.length > 0) {
      const obligation = await client.queryObligation(obligations[0].id);
      const collaterals = (obligation as any)?.collaterals || [];
      const matching = collaterals.find((c: any) => {
        const cType = normalizeCoinType(c.coinType || c.type || "");
        return cType === normalizedDepositCoin;
      });
      if (matching) {
        existingCollateral = Number(
          matching.amount || matching.depositAmount || 0,
        );
        console.log(
          `  Existing:    ${formatUnits(existingCollateral, decimals)} ${symbol}`,
        );
      }
    }

    // 7. Deposit
    if (existingCollateral > DEPOSIT_THRESHOLD) {
      console.log(
        `\n⏭️  Skipping deposit (existing > threshold: ${DEPOSIT_THRESHOLD})`,
      );
    } else {
      console.log(
        `\n🔄 Depositing ${formatUnits(DEPOSIT_AMOUNT, decimals)} ${symbol} as collateral...`,
      );

      // Use depositCollateral for leverage (adds to obligation)
      // If no obligation exists, it will be created automatically
      const depositResult = await client.depositCollateral(
        coinName,
        Number(DEPOSIT_AMOUNT),
        true, // sign and send
        obligations.length > 0 ? obligations[0].id : undefined,
      );

      console.log(`\n✅ Deposit successful!`);
      console.log(`📋 Digest: ${depositResult.digest}`);
    }

    console.log(`\n${"─".repeat(50)}`);
    console.log(`  ✨ Done!`);
    console.log("─".repeat(50));
  } catch (error: any) {
    console.error(`\n❌ ERROR: ${error.message || error}`);
    console.error(error.stack);
  }
}

main().catch(console.error);
