/**
 * DefiDash SDK - Portfolio Example
 *
 * Fetches aggregated portfolio across all supported protocols
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DefiDashSDK } from "../src";
import {
  logHeader,
  logFooter,
  logWallet,
  logSDKInit,
} from "../src/utils/logger";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

async function main() {
  logHeader("DefiDash SDK - Portfolio");

  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("   Error: SECRET_KEY not found in .env file.");
    return;
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  logWallet(keypair.getPublicKey().toSuiAddress());

  // Initialize SDK
  const sdk = new DefiDashSDK();
  await sdk.initialize(suiClient, keypair);
  logSDKInit(true);

  // Fetch aggregated portfolio
  console.log("\n   Fetching aggregated portfolio...\n");
  const portfolios = await sdk.getAggregatedPortfolio();

  for (const p of portfolios) {
    console.log(`\n   Protocol: ${p.protocol}`);
    console.log(`   Health Factor: ${p.healthFactor}`);
    console.log(`   Net Value: $${p.netValueUsd.toFixed(2)}`);
    console.log(`   Deposited (Supply): $${p.totalDepositedUsd?.toFixed(2)}`);
    console.log(`   Debt (Actual): $${p.totalDebtUsd.toFixed(2)}`);
    console.log(`   Weighted Borrows: $${p.weightedBorrowsUsd?.toFixed(2)}`);
    console.log(`   Borrow Limit: $${p.borrowLimitUsd?.toFixed(2)}`);
    console.log(`   Liq Threshold: $${p.liquidationThresholdUsd?.toFixed(2)}`);

    if (p.netApy !== undefined) {
      console.log(`   Net APY (Equity): ${p.netApy.toFixed(2)}%`);
      console.log(
        `   Annual Net Earnings: $${p.totalAnnualNetEarningsUsd?.toFixed(2)}`,
      );
    }

    if (p.positions.length > 0) {
      console.table(
        p.positions.map((pos) => ({
          Symbol: pos.symbol,
          Side: pos.side,
          Amount: pos.amount,
          ValueUSD: pos.valueUsd.toFixed(2),
          APY: (pos.apy * 100).toFixed(2) + "%",
          Rewards:
            pos.rewards
              ?.map((r) => `${r.amount.toFixed(6)} ${r.symbol}`)
              .join(", ") || "",
          EstLiq: pos.estimatedLiquidationPrice
            ? `$${pos.estimatedLiquidationPrice.toFixed(2)}`
            : "-",
        })),
      );
    } else {
      console.log("   No active positions.");
    }
  }

  logFooter("Portfolio fetch complete!");
}

main().catch(console.error);
