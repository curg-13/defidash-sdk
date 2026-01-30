/**
 * DefiDash SDK - Deleverage Test
 *
 * Tests the SDK deleverage functionality
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DefiDashSDK, LendingProtocol } from "../src";
import {
  logHeader,
  logFooter,
  logWallet,
  logSDKInit,
  logPosition,
  logStrategyResult,
} from "../src/utils/logger";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

async function main() {
  logHeader("🧪 DefiDash SDK - Deleverage Test");

  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("❌ Error: SECRET_KEY not found in .env file.");
    return;
  }

  const txMode = process.env.TX_MODE || "dryrun";
  const dryRun = txMode === "dryrun";
  if (!dryRun) {
    console.log(
      "\n   ⚠️ EXECUTION MODE - Real transactions will be submitted!",
    );
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  logWallet(keypair.getPublicKey().toSuiAddress());

  // Initialize SDK
  const sdk = new DefiDashSDK();
  await sdk.initialize(suiClient, keypair);
  logSDKInit(true);

  // Config - same as leverage.ts for consistency
  const depositAsset = process.env.LEVERAGE_DEPOSIT_COIN_TYPE || "LBTC";
  const protocolEnv = process.env.LEVERAGE_PROTOCOL || "suilend";
  const protocol =
    protocolEnv === "navi"
      ? LendingProtocol.Navi
      : protocolEnv === "scallop"
        ? LendingProtocol.Scallop
        : LendingProtocol.Suilend;

  console.log(`\n   📋 Configuration from .env:`);
  console.log(`      Protocol: ${protocolEnv}`);
  console.log(`      Expected Collateral: ${depositAsset}`);

  // Check position
  const position = await sdk.getPosition(protocol);
  logPosition(position, protocol);

  if (!position) {
    console.log("\n   ⚠️ No position found on this protocol.");
    console.log("   Run the leverage test first to create a position.");
    return;
  }

  // Verify collateral matches expected asset
  const positionAsset = position.collateral.symbol;
  if (positionAsset !== depositAsset) {
    console.log(
      `\n   ⚠️ Warning: Position collateral (${positionAsset}) differs from .env setting (${depositAsset})`,
    );
    console.log(
      `   Will deleverage the ${positionAsset} position on ${protocolEnv}`,
    );
  }

  if (position.debt.amount === 0n) {
    console.log("\n   ⚠️ No debt to repay - use withdraw instead");
    return;
  }

  // Execute
  console.log(
    `\n   🔄 Deleveraging ${positionAsset} position on ${protocolEnv}...`,
  );
  const result = await sdk.deleverage({
    protocol,
    dryRun,
  });
  logStrategyResult(result, "deleverage", dryRun);

  logFooter("Test complete!");
}

main().catch(console.error);
