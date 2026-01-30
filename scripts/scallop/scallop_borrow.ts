/**
 * Scallop Borrow Script
 *
 * Borrows assets from Scallop using native SDK.
 * Similar structure to suilend_borrow.ts
 *
 * Run with: npm run script:scallop-borrow
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
const BORROW_COIN_TYPE =
  process.env.BORROW_COIN_TYPE ||
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const BORROW_AMOUNT = process.env.BORROW_AMOUNT || "500000"; // 0.5 USDC
const BORROW_THRESHOLD = Number(process.env.BORROW_THRESHOLD) || 0;

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
  return COIN_NAME_MAP[normalized] || "usdc";
}

async function main() {
  console.log("─".repeat(50));
  console.log("  💸 Scallop Borrow Script");
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
  const normalizedBorrowCoin = normalizeCoinType(BORROW_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedBorrowCoin);
  const decimals = reserve?.decimals || 6;
  const symbol = reserve?.symbol || "USDC";
  const coinName = getCoinName(BORROW_COIN_TYPE);

  try {
    // 3. Check existing obligations
    const obligations = await client.getObligations();

    if (obligations.length === 0) {
      console.error(
        "\n❌ No obligations found. Please deposit collateral first.",
      );
      return;
    }

    const obligation = obligations[0];
    console.log(`\n📋 Obligation: ${obligation.id.slice(0, 20)}...`);

    // 4. Get obligation details and show current positions
    const obligationDetails = await client.queryObligation(obligation.id);
    const collaterals = (obligationDetails as any)?.collaterals || [];
    const debts = (obligationDetails as any)?.debts || [];

    if (collaterals.length > 0) {
      console.log(`\n💰 Current Collateral:`);
      for (const col of collaterals) {
        // Scallop uses type.name for coin type
        const rawCoinType = col.type?.name || "";
        const coinType = normalizeCoinType(rawCoinType);
        const colReserve = getReserveByCoinType(coinType);
        const colSymbol =
          colReserve?.symbol || rawCoinType.split("::").pop() || "???";
        const colDecimals = colReserve?.decimals || 9;
        const amount = col.amount || 0;
        console.log(`  • ${colSymbol}: ${formatUnits(amount, colDecimals)}`);
      }
    } else {
      console.log(`\n⚠️  No collateral found. Cannot borrow.`);
      return;
    }

    // Show current debts
    if (debts.length > 0) {
      console.log(`\n📊 Current Borrows:`);
      for (const debt of debts) {
        // Scallop uses type.name for coin type
        const rawDebtType = debt.type?.name || "";
        const debtCoinType = normalizeCoinType(rawDebtType);
        const debtReserve = getReserveByCoinType(debtCoinType);
        const debtSymbol =
          debtReserve?.symbol || rawDebtType.split("::").pop() || "???";
        const debtDecimals = debtReserve?.decimals || 6;
        const amount = debt.amount || 0;
        console.log(`  • ${debtSymbol}: ${formatUnits(amount, debtDecimals)}`);
      }
    } else {
      console.log(`\n📊 Current Borrows: None`);
    }

    // 5. Get price and show borrow info
    const assetPrice = await getTokenPrice(normalizedBorrowCoin);
    const humanAmount = Number(BORROW_AMOUNT) / Math.pow(10, decimals);
    const usdValue = humanAmount * assetPrice;

    // Check existing borrow
    const existingDebt = debts.find((d: any) => {
      const rawDType = d.type?.name || "";
      const dType = normalizeCoinType(rawDType);
      return dType === normalizedBorrowCoin;
    });
    const existingAmount = existingDebt ? Number(existingDebt.amount || 0) : 0;

    console.log(`\n📊 Borrow Info:`);
    console.log("─".repeat(45));
    console.log(`  Asset:       ${symbol} (${coinName})`);
    console.log(
      `  Amount:      ${formatUnits(BORROW_AMOUNT, decimals)} ${symbol} (Raw: ${BORROW_AMOUNT})`,
    );
    console.log(`  Price:       $${assetPrice.toFixed(4)}`);
    console.log(`  USD Value:   ~$${usdValue.toFixed(2)}`);
    if (existingDebt) {
      console.log(
        `  Existing:    ${formatUnits(existingAmount, decimals)} ${symbol}`,
      );
    }
    console.log("─".repeat(45));

    // 6. Execute borrow
    if (existingAmount >= BORROW_THRESHOLD && BORROW_THRESHOLD > 0) {
      console.log(
        `\n⏭️  Skipping borrow (existing >= threshold: ${BORROW_THRESHOLD})`,
      );
    } else {
      console.log(
        `\n🔄 Borrowing ${formatUnits(BORROW_AMOUNT, decimals)} ${symbol}...`,
      );

      // Scallop's borrow method requires obligation id and key
      const borrowResult = await client.borrow(
        coinName,
        Number(BORROW_AMOUNT),
        true, // sign and send
        obligation.id,
        obligation.keyId,
      );

      console.log(`\n✅ Borrow successful!`);
      console.log(`📋 Digest: ${borrowResult.digest}`);
      console.log(
        `💵 Received: ${formatUnits(BORROW_AMOUNT, decimals)} ${symbol} (~$${usdValue.toFixed(2)})`,
      );
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
