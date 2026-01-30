/**
 * Scallop Simple Withdraw - Execution Script
 *
 * Uses Scallop native SDK to withdraw all collateral for a specific asset.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { normalizeCoinType, formatUnits } from "../../src/utils";
import { getReserveByCoinType } from "../../src/lib/suilend/const";

const DRY_RUN_ONLY = process.env.DRY_RUN_ONLY !== "false";

// Scallop coin name mapping
const COIN_NAME_MAP: Record<string, string> = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI":
    "sui",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    "usdc",
};

function getCoinName(coinType: string): string {
  const normalized = normalizeCoinType(coinType);
  return (
    COIN_NAME_MAP[normalized] ||
    normalized.split("::").pop()?.toLowerCase() ||
    "sui"
  );
}

async function main() {
  console.log("═".repeat(60));
  console.log(
    `  Scallop Simple Withdraw - ${DRY_RUN_ONLY ? "DRY RUN" : "EXECUTION"}`,
  );
  console.log("═".repeat(60));

  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) return;

  const keypair = secretKey.startsWith("suiprivkey")
    ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(secretKey).secretKey)
    : Ed25519Keypair.fromSecretKey(Buffer.from(secretKey, "base64"));

  const userAddress = keypair.getPublicKey().toSuiAddress();
  const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });

  const scallop = new Scallop({ secretKey, networkType: "mainnet" });
  await scallop.init();
  const client = await scallop.createScallopClient();

  const obligations = await client.getObligations();
  const obligationsWithDetails = await Promise.all(
    obligations.map(async (o) => ({
      o,
      d: await client.queryObligation(o.id),
    })),
  );

  const selectedWithDetails =
    obligationsWithDetails.find(
      (x) => x.d && x.d.collaterals && x.d.collaterals.length > 0,
    ) || obligationsWithDetails[0];

  if (!selectedWithDetails || !selectedWithDetails.o) {
    console.log("No obligations found.");
    return;
  }

  const selectedObligation = selectedWithDetails.o;
  const details = selectedWithDetails.d;

  if (!details) {
    console.log("Could not fetch obligation details.");
    return;
  }

  console.log(`Using Obligation: ${selectedObligation.id}`);

  if (!details.collaterals || details.collaterals.length === 0) {
    console.log("No collateral found to withdraw.");
    return;
  }

  const builder = await scallop.createScallopBuilder();
  const tx = builder.createTxBlock();
  tx.setSender(userAddress);

  if (selectedObligation.locked) {
    console.log("Obligation is locked. Unstaking...");
    await tx.unstakeObligationQuick(
      selectedObligation.id,
      selectedObligation.keyId,
    );
  }

  for (const coll of details.collaterals as any[]) {
    const coinType = normalizeCoinType(coll.type?.name || coll.coinType || "");
    const coinName = getCoinName(coinType);
    const amount = Number(coll.amount);

    console.log(`Withdrawing ${formatUnits(amount, 9)} ${coinName}...`);
    const withdrawn = await tx.takeCollateral(
      selectedObligation.id,
      selectedObligation.keyId,
      amount,
      coinName,
    );
    tx.transferObjects([withdrawn], userAddress);
  }

  if (selectedObligation.locked) {
    console.log("Restaking obligation...");
    await tx.stakeObligationQuick(
      selectedObligation.id,
      selectedObligation.keyId,
    );
  }

  if (DRY_RUN_ONLY) {
    const dryRun = await suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.txBlock.build({ client: suiClient }),
    });
    console.log(`Dry Run Status: ${dryRun.effects.status.status}`);
  } else {
    console.log("Executing transaction...");
    const result = await builder.signAndSendTxBlock(tx);
    console.log(`✅ Success! Digest: ${result.digest}`);
  }
}

main().catch(console.error);
