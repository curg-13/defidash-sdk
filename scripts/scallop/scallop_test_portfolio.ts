/**
 * Scallop Test - Portfolio & Markets
 *
 * Tests ScallopAdapter's query functions:
 * - getPosition
 * - getAccountPortfolio
 * - getMarkets
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { DefiDashSDK, LendingProtocol } from "../../src/index";

async function main() {
    console.log("═".repeat(60));
    console.log("  Scallop Adapter Test - Portfolio & Markets");
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

    console.log("\n🔄 Initializing SDK (this initializes all adapters)...");
    const startTime = Date.now();
    await sdk.initialize(client, keypair);
    console.log(`✅ SDK initialized in ${Date.now() - startTime}ms`);

    // 2. Test getPosition
    console.log("\n" + "─".repeat(60));
    console.log("📊 Test: getPosition(LendingProtocol.Scallop)");
    console.log("─".repeat(60));

    try {
        const position = await sdk.getPosition(LendingProtocol.Scallop);
        if (position) {
            console.log("  Collateral:", position.collateral.symbol);
            console.log("    Amount:", position.collateral.amount.toString());
            console.log("    Value USD:", `$${position.collateral.valueUsd.toFixed(2)}`);
            console.log("  Debt:", position.debt.symbol);
            console.log("    Amount:", position.debt.amount.toString());
            console.log("    Value USD:", `$${position.debt.valueUsd.toFixed(2)}`);
            console.log("  Net Value:", `$${position.netValueUsd.toFixed(2)}`);
        } else {
            console.log("  ℹ️ No active Scallop position found");
        }
        console.log("✅ getPosition test passed");
    } catch (error: any) {
        console.error("❌ getPosition failed:", error.message);
    }

    // 3. Test hasPosition
    console.log("\n" + "─".repeat(60));
    console.log("📊 Test: hasPosition(LendingProtocol.Scallop)");
    console.log("─".repeat(60));

    try {
        const hasPos = await sdk.hasPosition(LendingProtocol.Scallop);
        console.log(`  Has Position: ${hasPos}`);
        console.log("✅ hasPosition test passed");
    } catch (error: any) {
        console.error("❌ hasPosition failed:", error.message);
    }

    // 4. Test getAggregatedMarkets (includes Scallop)
    console.log("\n" + "─".repeat(60));
    console.log("📊 Test: getAggregatedMarkets() - Scallop data");
    console.log("─".repeat(60));

    try {
        const markets = await sdk.getAggregatedMarkets();
        const scallopMarkets = markets.scallop || [];
        console.log(`  Found ${scallopMarkets.length} Scallop markets`);

        if (scallopMarkets.length > 0) {
            console.log("\n  Top 5 Markets:");
            console.table(
                scallopMarkets.slice(0, 5).map((m) => ({
                    Symbol: m.symbol,
                    Price: `$${m.price.toFixed(4)}`,
                    SupplyAPY: `${m.supplyApy.toFixed(2)}%`,
                    BorrowAPY: `${m.borrowApy.toFixed(2)}%`,
                    MaxLTV: `${(m.maxLtv * 100).toFixed(0)}%`,
                })),
            );
        }
        console.log("✅ getAggregatedMarkets test passed");
    } catch (error: any) {
        console.error("❌ getAggregatedMarkets failed:", error.message);
    }

    // 5. Test getAggregatedPortfolio (includes Scallop)
    console.log("\n" + "─".repeat(60));
    console.log("📊 Test: getAggregatedPortfolio() - Scallop data");
    console.log("─".repeat(60));

    try {
        const portfolios = await sdk.getAggregatedPortfolio();
        const scallopPortfolio = portfolios.find(
            (p) => p.protocol === LendingProtocol.Scallop,
        );

        if (scallopPortfolio) {
            console.log(`  Protocol: ${scallopPortfolio.protocol}`);
            console.log(`  Health Factor: ${scallopPortfolio.healthFactor}`);
            console.log(`  Net Value: $${scallopPortfolio.netValueUsd.toFixed(2)}`);
            console.log(
                `  Total Collateral: $${scallopPortfolio.totalCollateralUsd.toFixed(2)}`,
            );
            console.log(`  Total Debt: $${scallopPortfolio.totalDebtUsd.toFixed(2)}`);
            console.log(`  Positions: ${scallopPortfolio.positions.length}`);

            if (scallopPortfolio.positions.length > 0) {
                console.table(
                    scallopPortfolio.positions.map((p) => ({
                        Symbol: p.symbol,
                        Side: p.side,
                        Amount: p.amount.toFixed(6),
                        ValueUSD: `$${p.valueUsd.toFixed(2)}`,
                    })),
                );
            }
        }
        console.log("✅ getAggregatedPortfolio test passed");
    } catch (error: any) {
        console.error("❌ getAggregatedPortfolio failed:", error.message);
    }

    console.log("\n" + "═".repeat(60));
    console.log("  All Scallop tests completed!");
    console.log("═".repeat(60));
}

main().catch(console.error);
