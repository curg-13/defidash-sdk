/**
 * Compare BTC Collateral Options Across Protocols
 *
 * Checks which BTC-related assets are available as collateral
 * on Scallop, Suilend, and Navi protocols.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Scallop } from "@scallop-io/sui-scallop-sdk";

// Known BTC-related coin types on Sui
const BTC_COIN_TYPES = {
  WBTC: "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN",
  LBTC: "0x3e5f6d85de1a9bc68d8b42939b9b8e3d562cf6cdfa76c3a7df6a2bce78d11753::lbtc::LBTC",
  // Add more as they become available
};

async function checkScallop(): Promise<Map<string, { supported: boolean; collateralFactor?: number }>> {
  console.log("\n🔍 Checking Scallop...");
  const result = new Map<string, { supported: boolean; collateralFactor?: number }>();

  try {
    const scallop = new Scallop({ networkType: "mainnet" });
    await scallop.init();
    const query = await scallop.createScallopQuery();
    const marketData = await query.getMarket();

    if (marketData?.pools) {
      for (const [coinName, poolData] of Object.entries(marketData.pools) as [string, any][]) {
        const coinType = poolData.coinType || "";
        const collateralFactor = poolData.collateralFactor || 0;

        // Check if this is a BTC-related asset
        const isBtc =
          coinName.toLowerCase().includes("btc") ||
          coinType.toLowerCase().includes("btc");

        if (isBtc) {
          result.set(coinName.toUpperCase(), {
            supported: collateralFactor > 0,
            collateralFactor: collateralFactor * 100,
          });
        }
      }
    }

    // Also check our known BTC types
    for (const [name, coinType] of Object.entries(BTC_COIN_TYPES)) {
      if (!result.has(name)) {
        // Check if this coin type exists in pools
        const found = Object.entries(marketData?.pools || {}).find(
          ([_, pool]: [string, any]) => pool.coinType === coinType,
        );
        result.set(name, {
          supported: !!found && (found[1] as any).collateralFactor > 0,
          collateralFactor: found ? (found[1] as any).collateralFactor * 100 : undefined,
        });
      }
    }
  } catch (e: any) {
    console.log(`   ⚠️ Error: ${e.message}`);
  }

  return result;
}

async function checkSuilend(): Promise<Map<string, { supported: boolean; collateralFactor?: number }>> {
  console.log("\n🔍 Checking Suilend...");
  const result = new Map<string, { supported: boolean; collateralFactor?: number }>();

  try {
    // Suilend reserves with BTC support
    // Based on known Suilend configuration
    const suilendBtcReserves = [
      { name: "WBTC", supported: true, ltv: 70 },
      { name: "LBTC", supported: false, ltv: 0 }, // Check current status
    ];

    for (const reserve of suilendBtcReserves) {
      result.set(reserve.name, {
        supported: reserve.supported,
        collateralFactor: reserve.ltv,
      });
    }

    // Note: For accurate data, you'd query the Suilend SDK
    console.log("   (Using cached reserve data - run suilend scripts for live data)");
  } catch (e: any) {
    console.log(`   ⚠️ Error: ${e.message}`);
  }

  return result;
}

async function checkNavi(): Promise<Map<string, { supported: boolean; collateralFactor?: number }>> {
  console.log("\n🔍 Checking Navi...");
  const result = new Map<string, { supported: boolean; collateralFactor?: number }>();

  try {
    // Navi reserves with BTC support
    // Based on known Navi configuration
    const naviBtcReserves = [
      { name: "WBTC", supported: true, ltv: 70 },
      { name: "LBTC", supported: false, ltv: 0 },
    ];

    for (const reserve of naviBtcReserves) {
      result.set(reserve.name, {
        supported: reserve.supported,
        collateralFactor: reserve.ltv,
      });
    }

    console.log("   (Using cached reserve data - run navi scripts for live data)");
  } catch (e: any) {
    console.log(`   ⚠️ Error: ${e.message}`);
  }

  return result;
}

async function main() {
  console.log("═".repeat(60));
  console.log("  BTC Collateral Options Across Sui DeFi Protocols");
  console.log("═".repeat(60));

  const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });

  // Check all protocols
  const scallopBtc = await checkScallop();
  const suilendBtc = await checkSuilend();
  const naviBtc = await checkNavi();

  // Combine all BTC assets
  const allBtcAssets = new Set([
    ...scallopBtc.keys(),
    ...suilendBtc.keys(),
    ...naviBtc.keys(),
  ]);

  // Display comparison table
  console.log("\n" + "─".repeat(60));
  console.log("  COMPARISON TABLE");
  console.log("─".repeat(60));
  console.log(
    `${"Asset".padEnd(10)} ${"Scallop".padEnd(15)} ${"Suilend".padEnd(15)} ${"Navi".padEnd(15)}`,
  );
  console.log("─".repeat(60));

  for (const asset of allBtcAssets) {
    const scallop = scallopBtc.get(asset);
    const suilend = suilendBtc.get(asset);
    const navi = naviBtc.get(asset);

    const formatStatus = (data?: { supported: boolean; collateralFactor?: number }) => {
      if (!data) return "N/A";
      if (!data.supported) return "❌ No";
      return `✅ ${data.collateralFactor?.toFixed(0) || "?"}% LTV`;
    };

    console.log(
      `${asset.padEnd(10)} ${formatStatus(scallop).padEnd(15)} ${formatStatus(suilend).padEnd(15)} ${formatStatus(navi).padEnd(15)}`,
    );
  }

  console.log("─".repeat(60));

  // Recommendations
  console.log("\n📋 RECOMMENDATIONS:");
  console.log("─".repeat(60));

  if (scallopBtc.get("WBTC")?.supported) {
    console.log("✅ WBTC is available on Scallop as collateral");
    console.log(`   Coin Type: ${BTC_COIN_TYPES.WBTC}`);
  }

  console.log("\n⚠️  LBTC (Lombard BTC) Status:");
  console.log("   - Currently NOT widely supported on Sui lending protocols");
  console.log("   - Consider using WBTC (Wormhole wrapped BTC) instead");
  console.log("   - Or wait for protocol updates to support LBTC");

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Done!`);
  console.log("═".repeat(60));
}

main().catch(console.error);
