/**
 * Scallop Deleverage Strategy - Execution Script
 *
 * Executes the full deleverage flow with Scallop:
 * 1. Flash loan to cover debt
 * 2. Repay all debt
 * 3. Withdraw collateral
 * 4. Swap collateral to USDC
 * 5. Repay flash loan
 *
 * USAGE:
 * - Default (Dry Run): npm run script:scallop-deleverage-exec
 * - Execute: DRY_RUN_ONLY=false npm run script:scallop-deleverage-exec
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { DefiDashSDK, LendingProtocol } from "../../src/index";

// Configuration from environment
const DRY_RUN_ONLY = process.env.DRY_RUN_ONLY !== "false"; // Default to true for safety

async function main() {
    console.log("═".repeat(60));
    console.log("  Scallop Deleverage Strategy - EXECUTION Mode");
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
    console.log(`  Mode:           ${DRY_RUN_ONLY ? "🟡 DRY RUN ONLY" : "🔴 REAL EXECUTION"}`);

    if (DRY_RUN_ONLY) {
        console.log("\n⚠️  Safeguard active: Set DRY_RUN_ONLY=false to execute real transactions.");
    }

    // 2. Check current position
    console.log("\n" + "─".repeat(60));
    console.log("📊 Current Scallop Position:");
    console.log("─".repeat(60));

    try {
        const position = await sdk.getPosition(LendingProtocol.Scallop);

        if (!position) {
            console.log("  ℹ️ No active Scallop position found");
            console.log("  Cannot run deleverage without an existing position");
            return;
        }

        console.log(`  Collateral: ${position.collateral.symbol}`);
        console.log(`    Amount: ${position.collateral.amount.toString()}`);
        console.log(`    Value:  $${position.collateral.valueUsd.toFixed(2)}`);
        console.log(`  Debt: ${position.debt.symbol}`);
        console.log(`    Amount: ${position.debt.amount.toString()}`);
        console.log(`    Value:  $${position.debt.valueUsd.toFixed(2)}`);
        console.log(`  Net Value: $${position.netValueUsd.toFixed(2)}`);

        if (position.debt.amount === 0n) {
            console.log("\n  ℹ️ No debt to repay - use withdraw instead of deleverage");
            return;
        }
    } catch (error: any) {
        console.error("❌ Failed to get position:", error.message);
        return;
    }

    // 3. Execute
    console.log("\n" + "─".repeat(60));
    console.log(`🧪 Executing ${DRY_RUN_ONLY ? "DRY RUN" : "TRANSACTION"}...`);
    console.log("─".repeat(60));

    try {
        const result = await sdk.deleverage({
            protocol: LendingProtocol.Scallop,
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
        console.error("❌ Deleverage execution failed:", error.message);
        console.error(error.stack);
    }

    console.log("\n" + "═".repeat(60));
    console.log("  Done!");
    console.log("═".repeat(60));
}

main().catch(console.error);
