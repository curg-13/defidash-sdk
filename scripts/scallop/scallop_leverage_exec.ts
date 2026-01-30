/**
 * Scallop Leverage Strategy - Execution Script
 *
 * Executes the full leverage flow with Scallop:
 * 1. Flash loan USDC from Scallop
 * 2. Swap USDC to collateral asset
 * 3. Deposit collateral to Scallop
 * 4. Borrow USDC to repay flash loan
 *
 * USAGE:
 * - Default (Dry Run): npm run script:scallop-leverage-exec
 * - Execute: DRY_RUN_ONLY=false npm run script:scallop-leverage-exec
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { DefiDashSDK, LendingProtocol } from "../../src/index";

// Configuration from environment
const DEPOSIT_ASSET = process.env.LEVERAGE_DEPOSIT_COIN_TYPE || "SUI";
const DEPOSIT_AMOUNT = process.env.LEVERAGE_DEPOSIT_AMOUNT || "0.1"; // Human-readable
const MULTIPLIER = parseFloat(process.env.LEVERAGE_MULTIPLIER || "2");
const DRY_RUN_ONLY = process.env.DRY_RUN_ONLY !== "false"; // Default to true for safety

async function main() {
    console.log("═".repeat(60));
    console.log("  Scallop Leverage Strategy - EXECUTION Mode");
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

    const address = keypair.getPublicKey().toSuiAddress();
    console.log(`\n📍 Wallet: ${address}`);

    const client = new SuiClient({ url: getFullnodeUrl("mainnet") });
    const sdk = new DefiDashSDK();

    console.log("\n🔄 Initializing SDK...");
    await sdk.initialize(client, keypair);
    console.log("✅ SDK initialized");

    // 2. Show parameters
    console.log("\n" + "─".repeat(60));
    console.log("📋 Leverage Parameters:");
    console.log("─".repeat(60));
    console.log(`  Protocol:       Scallop`);
    console.log(`  Deposit Asset:  ${DEPOSIT_ASSET}`);
    console.log(`  Deposit Amount: ${DEPOSIT_AMOUNT}`);
    console.log(`  Multiplier:     ${MULTIPLIER}x`);
    console.log(`  Mode:           ${DRY_RUN_ONLY ? "🟡 DRY RUN ONLY" : "🔴 REAL EXECUTION"}`);

    if (DRY_RUN_ONLY) {
        console.log("\n⚠️  Safeguard active: Set DRY_RUN_ONLY=false to execute real transactions.");
    }

    // 3. Preview leverage
    console.log("\n" + "─".repeat(60));
    console.log("📊 Leverage Preview:");
    console.log("─".repeat(60));

    try {
        const preview = await sdk.previewLeverage({
            depositAsset: DEPOSIT_ASSET,
            depositAmount: DEPOSIT_AMOUNT,
            multiplier: MULTIPLIER,
        });

        console.log(`  Initial Equity:    $${preview.initialEquityUsd.toFixed(2)}`);
        console.log(`  Flash Loan USDC:   ${preview.flashLoanUsdc.toString()}`);
        console.log(`  Total Position:    $${preview.totalPositionUsd.toFixed(2)}`);
        console.log(`  Total Debt:        $${preview.debtUsd.toFixed(2)}`);
        console.log(`  Effective Mult:    ${preview.effectiveMultiplier.toFixed(2)}x`);
        console.log(`  LTV:               ${preview.ltvPercent.toFixed(2)}%`);
        console.log(`  Liquidation Price: $${preview.liquidationPrice.toFixed(4)}`);
        console.log(`  Price Drop Buffer: ${(preview.priceDropBuffer * 100).toFixed(2)}%`);

        // Check LTV safety
        if (preview.ltvPercent > 80) {
            console.error("\n⚠️  WARNING: High LTV! Execution recommended against.");
        }
    } catch (error: any) {
        console.error("⚠️ Preview failed:", error.message);
    }

    // 4. Execute
    console.log("\n" + "─".repeat(60));
    console.log(`🧪 Executing ${DRY_RUN_ONLY ? "DRY RUN" : "TRANSACTION"}...`);
    console.log("─".repeat(60));

    try {
        const result = await sdk.leverage({
            protocol: LendingProtocol.Scallop,
            depositAsset: DEPOSIT_ASSET,
            depositAmount: DEPOSIT_AMOUNT,
            multiplier: MULTIPLIER,
            dryRun: DRY_RUN_ONLY,
        });

        if (result.success) {
            if (DRY_RUN_ONLY) {
                console.log("✅ DRY RUN SUCCESS!");
            } else {
                console.log("✅ EXECUTION SUCCESS!");
                console.log(`  Digest: ${result.txDigest}`);
            }
            console.log(`  Gas Used: ${result.gasUsed?.toString()} MIST`);
        } else {
            console.log(`❌ ${DRY_RUN_ONLY ? "DRY RUN" : "EXECUTION"} FAILED:`);
            console.log(`  Error: ${result.error}`);
        }
    } catch (error: any) {
        console.error("❌ Leverage execution failed:", error.message);
        console.error(error.stack);
    }

    console.log("\n" + "═".repeat(60));
    console.log("  Done!");
    console.log("═".repeat(60));
}

main().catch(console.error);
