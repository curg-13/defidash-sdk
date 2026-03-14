/**
 * Asset Leverage Info Example
 *
 * Demonstrates using getAssetLeverageInfo() to compare leverage opportunities
 * across protocols for a given asset.
 *
 * Run: pnpm example:assetinfo
 */

import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { DefiDashSDK } from '../src';

async function main() {
  console.log('=== Asset Leverage Info Example ===\n');

  // Initialize SDK (read-only mode - no keypair needed)
  const client = new SuiClient({ url: getFullnodeUrl('mainnet') });
  const testAddress = '0x0000000000000000000000000000000000000000000000000000000000000001';
  const sdk = await DefiDashSDK.create(client, testAddress);

  // Query leverage info for SUI
  console.log('Fetching SUI leverage info across all protocols...\n');
  const suiInfos = await sdk.getAssetLeverageInfo('SUI');

  console.log('=== SUI Leverage Comparison ===\n');
  console.log(
    'Protocol'.padEnd(12) +
      'Max Multi'.padStart(12) +
      'LTV'.padStart(10) +
      'Supply APY'.padStart(12) +
      'Borrow APY'.padStart(12) +
      'Net APY*'.padStart(12),
  );
  console.log('-'.repeat(70));

  for (const info of suiInfos) {
    const netApy = info.apy.totalSupplyApy - info.apy.borrowApy;
    console.log(
      info.protocol.padEnd(12) +
        `${info.riskParams.maxMultiplier.toFixed(2)}x`.padStart(12) +
        `${(info.riskParams.ltv * 100).toFixed(1)}%`.padStart(10) +
        `${(info.apy.totalSupplyApy * 100).toFixed(2)}%`.padStart(12) +
        `${(info.apy.borrowApy * 100).toFixed(2)}%`.padStart(12) +
        `${(netApy * 100).toFixed(2)}%`.padStart(12),
    );
  }

  console.log('\n* Net APY = Supply APY - Borrow APY (simplified, not leveraged)');

  // Find best options
  const bestMultiplier = suiInfos.reduce((a, b) =>
    a.riskParams.maxMultiplier > b.riskParams.maxMultiplier ? a : b,
  );

  const bestNetApy = suiInfos.reduce((a, b) => {
    const aNet = a.apy.totalSupplyApy - a.apy.borrowApy;
    const bNet = b.apy.totalSupplyApy - b.apy.borrowApy;
    return aNet > bNet ? a : b;
  });

  console.log('\n=== Recommendations ===');
  console.log(
    `Best max leverage: ${bestMultiplier.protocol} (${bestMultiplier.riskParams.maxMultiplier.toFixed(2)}x)`,
  );
  console.log(
    `Best raw APY: ${bestNetApy.protocol} (${((bestNetApy.apy.totalSupplyApy - bestNetApy.apy.borrowApy) * 100).toFixed(2)}%)`,
  );
  console.log(`Current SUI price: $${suiInfos[0]?.priceUsd.toFixed(4)}`);
}

main().catch(console.error);
