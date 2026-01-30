/**
 * Scallop Deleverage Strategy - Execution Script
 *
 * Uses Scallop native SDK to close leveraged position:
 * 1. Flash loan USDC from Scallop (to repay debt)
 * 2. Repay all USDC debt on Scallop
 * 3. Withdraw all collateral from Scallop
 * 4. Swap withdrawn asset → USDC using 7k
 * 5. Repay Scallop flash loan
 * 6. Transfer remaining funds to user
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
import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../../src/lib/scallop";
import { normalizeCoinType, formatUnits } from "../../src/utils";
import { COIN_TYPES } from "../../src/types/constants";
import { getReserveByCoinType } from "../../src/lib/suilend/const";

const USDC_COIN_TYPE = COIN_TYPES.USDC;
const DRY_RUN_ONLY = process.env.DRY_RUN_ONLY !== "false"; // Default to true for safety

// Scallop coin name mapping
const COIN_NAME_MAP: Record<string, string> = {
  "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI":
    "sui",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC":
    "usdc",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN":
    "wusdc",
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN":
    "wusdt",
};

function getCoinName(coinType: string): string {
  const normalized = normalizeCoinType(coinType);
  return (
    COIN_NAME_MAP[normalized] ||
    normalized.split("::").pop()?.toLowerCase() ||
    "sui"
  );
}

async function main() {
  console.log("═".repeat(60));
  console.log(
    `  Scallop Deleverage Strategy - ${DRY_RUN_ONLY ? "DRY RUN" : "EXECUTION"}`,
  );
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
  console.log(`   Mode: ${DRY_RUN_ONLY ? "🟡 DRY RUN" : "🔴 REAL EXECUTION"}`);

  if (DRY_RUN_ONLY) {
    console.log(
      `\n⚠️  Safeguard active: Set DRY_RUN_ONLY=false to execute real transactions.`,
    );
  }

  const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 2. Initialize Scallop SDK
  console.log(`\n🔄 Initializing Scallop SDK...`);
  const scallop = new Scallop({
    secretKey: secretKey,
    networkType: "mainnet",
  });
  await scallop.init();

  const client = await scallop.createScallopClient();

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
    // Try the other obligations if the first one is empty
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
  console.log(
    `   Using obligation: ${obligationId.slice(0, 20)}...${selectedObligation.locked ? " (LOCKED - will unstake in PTB)" : ""}`,
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
  let supplyCoinName = "";

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
    supplyCoinName = getCoinName(coinType);
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
    console.log(`   Use a simple withdraw instead.`);
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
    // 4. Calculate flash loan amount (borrow amount + buffer for interest and fees)
    // Add 0.5% buffer for interest accrued between calculation and execution
    const borrowAmountWithInterest =
      (borrowAmount * BigInt(1005)) / BigInt(1000);
    const flashLoanBuffer =
      (borrowAmountWithInterest * BigInt(102)) / BigInt(100); // 2% buffer for fees
    const flashLoanUsdc = flashLoanBuffer;
    const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
    const totalRepayment = flashLoanUsdc + flashLoanFee;

    console.log(`\n🔍 Flash Loan Details:`);
    console.log(`  Debt (estimated): ${formatUnits(borrowAmount, 6)} USDC`);
    console.log(
      `  Flash Loan:       ${formatUnits(flashLoanUsdc, 6)} USDC (includes interest buffer)`,
    );
    console.log(`  Flash Fee:        ${formatUnits(flashLoanFee, 6)} USDC`);

    // 5. Get swap quote: collateral → USDC
    // Plan to withdraw 100% of collateral
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
      `  Swap: ${formatUnits(withdrawAmount, supplyDecimals)} ${supplySymbol} → ${formatUnits(expectedUsdcOut, 6)} USDC`,
    );

    // 6. Build Transaction using Scallop SDK
    console.log(`\n🔧 Building transaction...`);

    const builder = await scallop.createScallopBuilder();
    const tx = builder.createTxBlock();
    tx.setSender(userAddress);

    // Step 1: Flash loan USDC
    console.log(`  Step 1: Flash loan ${formatUnits(flashLoanUsdc, 6)} USDC`);
    const [loanCoin, receipt] = await tx.borrowFlashLoan(
      Number(flashLoanUsdc),
      "usdc",
    );

    // Step 2: Unstake obligation if it's locked (for Borrow Incentive)
    console.log(`  Step 2: Check and unstake obligation if locked`);
    await tx.unstakeObligationQuick(obligationId, obligationKeyId);

    // Step 3: Update oracles
    console.log(`  Step 3: Update oracles for ${supplyCoinName} and usdc`);
    await tx.updateAssetPricesQuick([supplyCoinName, "usdc"]);

    // Step 4: Repay ALL debt on Scallop
    console.log(`  Step 4: Repay USDC debt (using flash loan coin)`);
    // Scallop's repay will take what's needed from the coin.
    // We pass the whole loanCoin (it contains 100.5% of estimated debt).
    await tx.repay(tx.txBlock.object(obligationId), loanCoin, "usdc");

    // Step 5: Withdraw ALL collateral
    // Scallop takeCollateral requires exact amount. We use current amount.
    // Since debt is fully repaid, we can take everything.
    console.log(
      `  Step 5: Withdraw ${formatUnits(withdrawAmount, supplyDecimals)} ${supplySymbol}`,
    );
    const withdrawnCoin = await tx.takeCollateral(
      tx.txBlock.object(obligationId),
      tx.txBlock.object(obligationKeyId),
      Number(withdrawAmount),
      supplyCoinName,
    );

    // Step 6: Restake obligation (if we want to keep it in Borrow Incentive)
    console.log(
      `  Step 6: Restake obligation (now empty) to resume rewards readiness`,
    );
    await tx.stakeObligationQuick(obligationId, obligationKeyId);

    // Step 7: Swap withdrawn collateral → USDC
    console.log(`  Step 7: Swap ${supplySymbol} → USDC`);
    const swappedUsdc = await metaAg.swap(
      {
        quote: bestQuote,
        signer: userAddress,
        coinIn: withdrawnCoin,
        tx: tx.txBlock,
      },
      100, // slippage
    );

    // Step 8: Merge swapped USDC with remaining loan coin and repay flash loan
    console.log(`  Step 8: Repay flash loan`);
    // Merge swapped USDC and whatever remains from the loan coin
    tx.mergeCoins(swappedUsdc, [loanCoin]);

    // Split the exact amount needed for flash loan repayment
    const [flashRepayment] = tx.splitCoins(swappedUsdc, [
      Number(totalRepayment),
    ]);
    await tx.repayFlashLoan(flashRepayment, receipt, "usdc");

    // Step 9: Transfer remaining assets to user
    console.log(`  Step 9: Transfer remaining assets to user`);
    tx.transferObjects([swappedUsdc], userAddress);

    // 7. Execute or Dry Run
    console.log(`\n${"─".repeat(60)}`);
    console.log(
      `🧪 ${DRY_RUN_ONLY ? "Running dry-run" : "Executing transaction"}...`,
    );
    console.log("─".repeat(60));

    if (DRY_RUN_ONLY) {
      const dryRunResult = await suiClient.dryRunTransactionBlock({
        transactionBlock: await tx.txBlock.build({ client: suiClient }),
      });

      if (dryRunResult.effects.status.status === "success") {
        console.log(`✅ DRY RUN SUCCESS!`);
        console.log(
          `   Gas estimate: ${dryRunResult.effects.gasUsed.computationCost} MIST`,
        );

        console.log(`\n📊 Expected Result:`);
        console.log("─".repeat(60));
        console.log(`  Position would be closed successfully`);
        console.log(`  Net assets would be returned to your wallet`);
        console.log("─".repeat(60));
      } else {
        console.log(`❌ DRY RUN FAILED:`);
        console.log(`   Error: ${dryRunResult.effects.status.error}`);
      }
    } else {
      // Real execution
      console.log(`\n⚠️  Signing and sending transaction...`);
      const result = await builder.signAndSendTxBlock(tx);

      console.log(`\n✅ EXECUTION SUCCESS!`);
      console.log(`📋 Digest: ${result.digest}`);
      console.log(`\n🎉 Position closed successfully!`);
      console.log(`   Assets have been returned to your wallet`);
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
