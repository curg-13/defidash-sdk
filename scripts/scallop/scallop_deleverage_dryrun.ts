/**
 * Scallop Deleverage Strategy - Dry Run
 *
 * Uses plain Transaction (not Scallop SDK wrapper) for better compatibility with 7k swap.
 * This approach is same as SDK's deleverage strategy.
 *
 * Flow:
 * 1. Flash loan USDC from Scallop (to repay debt)
 * 2. Repay all USDC debt on Scallop
 * 3. Withdraw all collateral from Scallop
 * 4. Swap withdrawn asset → USDC using 7k
 * 5. Repay Scallop flash loan
 * 6. Transfer remaining funds to user
 *
 * This runs as DRY RUN only - no actual execution
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { SUI_CLOCK_OBJECT_ID } from "@mysten/sui/utils";
import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../../src/lib/scallop";
import { normalizeCoinType, formatUnits } from "../../src/utils";
import { COIN_TYPES } from "../../src/types/constants";
import { getReserveByCoinType } from "../../src/lib/suilend/const";

const USDC_COIN_TYPE = COIN_TYPES.USDC;

// Scallop coin name to type mapping
const COIN_TYPE_MAP: Record<string, string> = {
  sui: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
  usdc: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  wusdc:
    "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
  wusdt:
    "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
  xbtc: "0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC",
};

function getCoinType(coinName: string): string {
  return COIN_TYPE_MAP[coinName.toLowerCase()] || coinName;
}

function getCoinName(coinType: string): string {
  const normalized = normalizeCoinType(coinType);
  for (const [name, type] of Object.entries(COIN_TYPE_MAP)) {
    if (normalizeCoinType(type) === normalized) return name;
  }
  return normalized.split("::").pop()?.toLowerCase() || "unknown";
}

async function main() {
  console.log("═".repeat(60));
  console.log("  Scallop Deleverage Strategy - DRY RUN (Plain Transaction)");
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

  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`\n📍 Wallet: ${userAddress}`);

  const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 2. Initialize Scallop SDK (only for querying addresses and positions)
  console.log(`\n🔄 Initializing Scallop SDK...`);
  const scallop = new Scallop({
    secretKey: secretKey,
    networkType: "mainnet",
  });
  await scallop.init();

  const client = await scallop.createScallopClient();

  // Get addresses from Scallop SDK
  const addresses = scallop.client.address.getAddresses();
  if (!addresses) {
    throw new Error("Failed to get Scallop addresses");
  }

  const coreAddresses = {
    protocolPkg: addresses.core.packages?.protocol?.id || "",
    version: addresses.core.version,
    market: addresses.core.market,
    coinDecimalsRegistry: addresses.core.coinDecimalsRegistry,
    xOracle: addresses.core.oracles.xOracle,
    obligationAccessStore: addresses.core.obligationAccessStore,
  };

  const borrowIncentiveAddresses = {
    pkg: addresses.borrowIncentive.id,
    config: addresses.borrowIncentive.config,
    incentivePools: addresses.borrowIncentive.incentivePools,
    incentiveAccounts: addresses.borrowIncentive.incentiveAccounts,
  };

  const veScaAddresses = {
    subsTable: addresses.vesca.subsTable,
    subsWhitelist: addresses.vesca.subsWhitelist,
  };

  console.log(
    `   Protocol pkg: ${coreAddresses.protocolPkg.slice(0, 16)}...`,
  );

  // 3. Get current Scallop position
  console.log(`\n📊 Fetching current Scallop position...`);

  const obligations = await client.getObligations();

  if (obligations.length === 0) {
    console.log(`\n⚠️  No obligations found on Scallop`);
    return;
  }

  // Find obligation with active positions
  let selectedObligation = obligations[0];
  let obligationDetails = await client.queryObligation(selectedObligation.id);

  if (
    obligationDetails &&
    (!obligationDetails.collaterals ||
      obligationDetails.collaterals.length === 0) &&
    (!obligationDetails.debts || obligationDetails.debts.length === 0)
  ) {
    for (let i = 1; i < obligations.length; i++) {
      const details = await client.queryObligation(obligations[i].id);
      if (
        details &&
        ((details.collaterals && details.collaterals.length > 0) ||
          (details.debts && details.debts.length > 0))
      ) {
        selectedObligation = obligations[i];
        obligationDetails = details;
        break;
      }
    }
  }

  if (!obligationDetails) {
    console.log(`\n⚠️  Could not fetch obligation details`);
    return;
  }

  const obligationId = selectedObligation.id;
  const obligationKeyId = selectedObligation.keyId;
  const isLocked = selectedObligation.locked;

  console.log(
    `   Using obligation: ${obligationId.slice(0, 20)}...${isLocked ? " 🔒 LOCKED" : ""}`,
  );

  const collaterals = obligationDetails.collaterals || [];
  const debts = obligationDetails.debts || [];

  if (collaterals.length === 0 && debts.length === 0) {
    console.log(`\n⚠️  No active positions found on Scallop`);
    return;
  }

  console.log(`\n📋 Active Positions:`);
  console.log("─".repeat(60));

  let supplyCoinType = "";
  let supplyAmount = 0n;
  let supplySymbol = "";
  let supplyDecimals = 9;

  let borrowCoinType = "";
  let borrowAmount = 0n;
  let borrowSymbol = "";
  let borrowDecimals = 6;

  for (const collateral of collaterals as any[]) {
    const coinType = normalizeCoinType(
      collateral.type?.name || collateral.coinType || "",
    );
    const reserveInfo = getReserveByCoinType(coinType);
    const symbol = reserveInfo?.symbol || coinType.split("::").pop() || "???";
    const decimals = reserveInfo?.decimals || 9;
    const amount = BigInt(collateral.amount || 0);

    console.log(`  Supply:  ${formatUnits(amount, decimals)} ${symbol}`);
    supplyCoinType = coinType;
    supplyAmount = amount;
    supplySymbol = symbol;
    supplyDecimals = decimals;
  }

  for (const debt of debts as any[]) {
    const coinType = normalizeCoinType(debt.type?.name || debt.coinType || "");
    const reserveInfo = getReserveByCoinType(coinType);
    const symbol = reserveInfo?.symbol || coinType.split("::").pop() || "???";
    const decimals = reserveInfo?.decimals || 6;
    const amount = BigInt(debt.amount || 0);

    console.log(`  Borrow:  ${formatUnits(amount, decimals)} ${symbol}`);
    borrowCoinType = coinType;
    borrowAmount = amount;
    borrowSymbol = symbol;
    borrowDecimals = decimals;
  }
  console.log("─".repeat(60));

  if (!supplyCoinType || supplyAmount === 0n) {
    console.log(`\n⚠️  No supply position found to withdraw`);
    return;
  }

  if (!borrowCoinType || borrowAmount === 0n) {
    console.log(`\n⚠️  No borrow position found - nothing to deleverage`);
    return;
  }

  // Get prices
  const supplyPrice = await getTokenPrice(supplyCoinType);
  const usdcPrice = await getTokenPrice(USDC_COIN_TYPE);

  const supplyValueUsd =
    (Number(supplyAmount) / Math.pow(10, supplyDecimals)) * supplyPrice;
  const borrowValueUsd =
    (Number(borrowAmount) / Math.pow(10, borrowDecimals)) * usdcPrice;
  const netValueUsd = supplyValueUsd - borrowValueUsd;

  console.log(`\n📊 Position Summary:`);
  console.log("─".repeat(60));
  console.log(
    `  Collateral: ${formatUnits(supplyAmount, supplyDecimals)} ${supplySymbol} (~$${supplyValueUsd.toFixed(2)})`,
  );
  console.log(
    `  Debt:       ${formatUnits(borrowAmount, borrowDecimals)} ${borrowSymbol} (~$${borrowValueUsd.toFixed(2)})`,
  );
  console.log(`  Net Value:  ~$${netValueUsd.toFixed(2)}`);
  console.log("─".repeat(60));

  try {
    // 4. Calculate flash loan amount
    const borrowAmountWithInterest = (borrowAmount * 1005n) / 1000n;
    const flashLoanUsdc = borrowAmountWithInterest;
    const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
    const totalRepayment = flashLoanUsdc + flashLoanFee;

    console.log(`\n🔍 Flash Loan Details:`);
    console.log(`  Debt (estimated): ${formatUnits(borrowAmount, 6)} USDC`);
    console.log(
      `  Flash Loan:       ${formatUnits(flashLoanUsdc, 6)} USDC (includes buffer)`,
    );
    console.log(`  Flash Fee:        ${formatUnits(flashLoanFee, 6)} USDC`);

    // 5. Get swap quote
    const withdrawAmount = supplyAmount;

    console.log(`\n🔍 Fetching swap quote: ${supplySymbol} → USDC...`);
    const swapQuotes = await metaAg.quote({
      amountIn: withdrawAmount.toString(),
      coinTypeIn: supplyCoinType,
      coinTypeOut: USDC_COIN_TYPE,
    });

    if (swapQuotes.length === 0) {
      console.log(`\n⚠️  No swap quotes found for ${supplySymbol} → USDC`);
      return;
    }

    const bestQuote = swapQuotes.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut),
    )[0];

    const expectedUsdcOut = BigInt(bestQuote.amountOut);

    console.log(
      `  Route: ${(bestQuote as any).routes?.map((r: any) => r.dex || r.name || "unknown").join(" → ") || "unknown"}`,
    );
    console.log(
      `  Swap: ${formatUnits(withdrawAmount, supplyDecimals)} ${supplySymbol} → ${formatUnits(expectedUsdcOut, 6)} USDC`,
    );

    // 6. Build Transaction using plain Transaction (NOT Scallop SDK wrapper)
    console.log(`\n🔧 Building transaction (Plain Transaction)...`);

    const tx = new Transaction();
    tx.setSender(userAddress);
    tx.setGasBudget(50_000_000); // 0.05 SUI

    const flashLoanClient = new ScallopFlashLoanClient({
      protocolPkg: coreAddresses.protocolPkg,
      version: coreAddresses.version,
      market: coreAddresses.market,
    });

    // Step 0: Unstake obligation if locked
    if (isLocked) {
      console.log(`  Step 0: Unstake obligation (required for operations)`);
      const clockRef = tx.sharedObjectRef({
        objectId: SUI_CLOCK_OBJECT_ID,
        mutable: false,
        initialSharedVersion: "1",
      });
      tx.moveCall({
        target: `${borrowIncentiveAddresses.pkg}::user::unstake_v2`,
        arguments: [
          tx.object(borrowIncentiveAddresses.config),
          tx.object(borrowIncentiveAddresses.incentivePools),
          tx.object(borrowIncentiveAddresses.incentiveAccounts),
          tx.object(obligationKeyId),
          tx.object(obligationId),
          tx.object(veScaAddresses.subsTable),
          tx.object(veScaAddresses.subsWhitelist),
          clockRef,
        ],
      });
    }

    // Step 1: Flash loan USDC
    console.log(`  Step 1: Flash loan ${formatUnits(flashLoanUsdc, 6)} USDC`);
    const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
      tx,
      flashLoanUsdc,
      "usdc",
    );

    // Step 2: Repay debt
    console.log(`  Step 2: Repay USDC debt`);
    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: "1",
    });
    tx.moveCall({
      target: `${coreAddresses.protocolPkg}::repay::repay`,
      typeArguments: [borrowCoinType],
      arguments: [
        tx.object(coreAddresses.version),
        tx.object(obligationId),
        tx.object(coreAddresses.market),
        loanCoin as any,
        clockRef,
      ],
    });

    // Step 3: Withdraw collateral
    console.log(
      `  Step 3: Withdraw ${formatUnits(withdrawAmount, supplyDecimals)} ${supplySymbol}`,
    );
    const clockRef2 = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: "1",
    });
    const [withdrawnCoin] = tx.moveCall({
      target: `${coreAddresses.protocolPkg}::withdraw_collateral::withdraw_collateral`,
      typeArguments: [supplyCoinType],
      arguments: [
        tx.object(coreAddresses.version),
        tx.object(obligationId),
        tx.object(obligationKeyId),
        tx.object(coreAddresses.market),
        tx.object(coreAddresses.coinDecimalsRegistry),
        tx.pure.u64(withdrawAmount),
        tx.object(coreAddresses.xOracle),
        clockRef2,
      ],
    });

    // Step 4: Swap collateral → USDC (pass tx directly, NOT tx.txBlock)
    console.log(`  Step 4: Swap ${supplySymbol} → USDC`);
    const swappedUsdc = await metaAg.swap(
      {
        quote: bestQuote,
        signer: userAddress,
        coinIn: withdrawnCoin,
        tx: tx, // Plain Transaction, not tx.txBlock!
      },
      100, // 1% slippage
    );

    // Step 5: Repay flash loan
    console.log(`  Step 5: Repay flash loan`);
    const [flashRepayment] = tx.splitCoins(swappedUsdc as any, [
      totalRepayment,
    ]);
    flashLoanClient.repayFlashLoan(tx, flashRepayment as any, receipt, "usdc");

    // Step 6: Transfer remaining to user
    console.log(`  Step 6: Transfer remaining assets to user`);
    tx.transferObjects([swappedUsdc as any], userAddress);

    // 7. Dry Run
    console.log(`\n${"─".repeat(60)}`);
    console.log(`🧪 Running dry-run...`);
    console.log("─".repeat(60));

    const dryRunResult = await suiClient.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: suiClient }),
    });

    if (dryRunResult.effects.status.status === "success") {
      console.log(`✅ DRY RUN SUCCESS!`);
      console.log(
        `   Gas estimate: ${dryRunResult.effects.gasUsed.computationCost} MIST`,
      );

      const estimatedProfit = expectedUsdcOut - totalRepayment;
      console.log(`\n📊 Expected Result:`);
      console.log("─".repeat(60));
      console.log(`  Position would be closed successfully`);
      console.log(`  Estimated USDC profit: ~${formatUnits(estimatedProfit, 6)} USDC`);
      console.log("─".repeat(60));
    } else {
      console.log(`❌ DRY RUN FAILED:`);
      console.log(`   Error: ${dryRunResult.effects.status.error}`);
    }
  } catch (error: any) {
    console.error(`\n❌ Error:`, error.message);
    console.error(error.stack);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Done!`);
  console.log("═".repeat(60));
}

main().catch(console.error);
