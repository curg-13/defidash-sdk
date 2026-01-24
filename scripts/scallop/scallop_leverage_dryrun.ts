/**
 * Scallop Leverage Strategy - Dry Run Test
 *
 * Tests the full leverage flow with Scallop:
 * 1. Flash loan USDC from Scallop
 * 2. Swap USDC to collateral asset
 * 3. Deposit collateral to Scallop
 * 4. Borrow USDC to repay flash loan
 *
 * This runs as DRY RUN only - no actual execution
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

async function main() {
    console.log("═".repeat(60));
    console.log("  Scallop Leverage Strategy - DRY RUN");
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
    } catch (error: any) {
        console.error("⚠️ Preview failed:", error.message);
    }

    // 4. Execute dry run
    console.log("\n" + "─".repeat(60));
    console.log("🧪 Executing DRY RUN...");
    console.log("─".repeat(60));

    try {
        const result = await sdk.leverage({
            protocol: LendingProtocol.Scallop,
            depositAsset: DEPOSIT_ASSET,
            depositAmount: DEPOSIT_AMOUNT,
            multiplier: MULTIPLIER,
            dryRun: true, // DRY RUN - no actual execution
        });

        if (result.success) {
            console.log("✅ DRY RUN SUCCESS!");
            console.log(`  Gas Used: ${result.gasUsed?.toString()} MIST`);
        } else {
            console.log("❌ DRY RUN FAILED:");
            console.log(`  Error: ${result.error}`);
        }
    } catch (error: any) {
        console.error("❌ Leverage execution failed:", error.message);
        console.error(error.stack);
    }

    console.log("\n" + "═".repeat(60));
    console.log("  Dry run test completed");
    console.log("═".repeat(60));
}

main().catch(console.error);
