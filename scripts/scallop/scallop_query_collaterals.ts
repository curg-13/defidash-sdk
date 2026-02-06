/**
 * Scallop Query Collaterals Script
 *
 * Queries all available collateral assets on Scallop protocol.
 * Shows which assets can be used as collateral for borrowing.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { Scallop } from "@scallop-io/sui-scallop-sdk";

async function main() {
  console.log("═".repeat(60));
  console.log("  Scallop - Available Collateral Assets");
  console.log("═".repeat(60));

  // Initialize Scallop SDK
  console.log(`\n🔄 Initializing Scallop SDK...`);
  const scallop = new Scallop({ networkType: "mainnet" });
  await scallop.init();

  const query = await scallop.createScallopQuery();

  // Get market pools (lending/borrowing) and collaterals separately
  // Use indexer: true to avoid LayerZero asset check errors
  console.log(`\n📊 Fetching market data...\n`);

  const [marketPoolsData, marketCollateralsData] = await Promise.all([
    query.getMarketPools(undefined, { indexer: true }),
    query.getMarketCollaterals(undefined, { indexer: true }),
  ]);

  const pools = marketPoolsData.pools || {};
  const collaterals = marketCollateralsData || {};

  // Collateral assets from getMarketCollaterals
  const collateralAssets: Array<{
    name: string;
    coinType: string;
    collateralFactor: number;
    totalSupply: number;
    maxCollateralAmount: number;
  }> = [];

  // Borrowable assets from getMarketPools
  const borrowableAssets: Array<{
    name: string;
    coinType: string;
    borrowApy: number;
    supplyApy: number;
    totalBorrow: number;
    totalSupply: number;
  }> = [];

  // Process collaterals
  for (const [coinName, colData] of Object.entries(collaterals) as [string, any][]) {
    const coinType = colData.coinType || "";
    const collateralFactor = colData.collateralFactor || 0;
    const totalSupply = colData.totalCollateralAmount || colData.depositAmount || 0;
    const maxCollateralAmount = colData.maxCollateralAmount || 0;

    collateralAssets.push({
      name: coinName.toUpperCase(),
      coinType,
      collateralFactor: collateralFactor * 100,
      totalSupply,
      maxCollateralAmount,
    });
  }

  // Process lending pools
  for (const [coinName, poolData] of Object.entries(pools) as [string, any][]) {
    const coinType = poolData.coinType || "";
    const totalBorrow = poolData.borrowAmount || 0;
    const totalSupply = poolData.supplyAmount || 0;
    const supplyApy = (poolData.supplyApy || 0) * 100;
    const borrowApy = (poolData.borrowApy || 0) * 100;

    borrowableAssets.push({
      name: coinName.toUpperCase(),
      coinType,
      borrowApy,
      supplyApy,
      totalBorrow,
      totalSupply,
    });
  }

  // Sort by collateral factor (highest first)
  collateralAssets.sort((a, b) => b.collateralFactor - a.collateralFactor);

  // Display collateral assets
  console.log("─".repeat(60));
  console.log("  COLLATERAL ASSETS (can be deposited as collateral)");
  console.log("─".repeat(60));
  console.log(
    `${"Asset".padEnd(12)} ${"Collateral Factor".padEnd(18)} Coin Type`,
  );
  console.log("─".repeat(60));

  for (const asset of collateralAssets) {
    const shortCoinType =
      asset.coinType.length > 30
        ? `${asset.coinType.slice(0, 15)}...${asset.coinType.slice(-12)}`
        : asset.coinType;

    console.log(
      `${asset.name.padEnd(12)} ${(asset.collateralFactor.toFixed(1) + "%").padEnd(18)} ${shortCoinType}`,
    );
  }

  console.log("─".repeat(60));
  console.log(`Total: ${collateralAssets.length} collateral assets\n`);

  // Display borrowable/lending assets
  console.log("─".repeat(60));
  console.log("  LENDING POOLS (supply & borrow)");
  console.log("─".repeat(60));
  console.log(`${"Asset".padEnd(12)} ${"Supply APY".padEnd(12)} ${"Borrow APY".padEnd(12)} Coin Type`);
  console.log("─".repeat(60));

  for (const asset of borrowableAssets) {
    const shortCoinType =
      asset.coinType.length > 30
        ? `${asset.coinType.slice(0, 15)}...${asset.coinType.slice(-12)}`
        : asset.coinType;

    console.log(
      `${asset.name.padEnd(12)} ${(asset.supplyApy.toFixed(2) + "%").padEnd(12)} ${(asset.borrowApy.toFixed(2) + "%").padEnd(12)} ${shortCoinType}`,
    );
  }

  console.log("─".repeat(60));
  console.log(`Total: ${borrowableAssets.length} lending pools\n`);

  // Check for BTC-related assets
  console.log("─".repeat(60));
  console.log("  BTC-RELATED ASSETS SEARCH");
  console.log("─".repeat(60));

  const btcKeywords = ["btc", "wbtc", "lbtc", "sbtc", "bitcoin"];
  const btcAssets = collateralAssets.filter((a) =>
    btcKeywords.some((kw) => a.name.toLowerCase().includes(kw)),
  );

  if (btcAssets.length > 0) {
    console.log("✅ Found BTC-related collateral assets:");
    for (const asset of btcAssets) {
      console.log(
        `   - ${asset.name}: ${asset.collateralFactor.toFixed(1)}% collateral factor`,
      );
      console.log(`     Coin Type: ${asset.coinType}`);
    }
  } else {
    console.log("❌ No BTC-related assets found in Scallop collateral list.");
    console.log("\n   Available BTC options on Sui:");
    console.log("   - wBTC (Wormhole): May need to check if Scallop supports it");
    console.log("   - LBTC: Not currently supported on Scallop");
    console.log(
      "\n   Consider using Suilend or Navi for BTC collateral options.",
    );
  }

  // Print full coin type list for reference
  console.log("\n" + "─".repeat(60));
  console.log("  FULL COIN TYPE LIST (for SDK integration)");
  console.log("─".repeat(60));

  for (const asset of collateralAssets) {
    console.log(`${asset.name}:`);
    console.log(`  ${asset.coinType}`);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Done!`);
  console.log("═".repeat(60));
}

main().catch(console.error);
