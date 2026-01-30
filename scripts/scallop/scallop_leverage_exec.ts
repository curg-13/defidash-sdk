/**
 * Scallop Leverage Strategy - Execution Script
 *
 * Uses Scallop native SDK for proper oracle updates and flash loans.
 * Flow:
 * 1. Flash loan USDC from Scallop
 * 2. Swap USDC to deposit asset (7k aggregator)
 * 3. Create new obligation and deposit as collateral
 * 4. Borrow USDC to repay flash loan
 * 5. Repay flash loan
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
import { Scallop } from "@scallop-io/sui-scallop-sdk";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../../src/lib/scallop";
import { normalizeCoinType, formatUnits, parseUnits } from "../../src/utils";
import { COIN_TYPES } from "../../src/types/constants";
import { getReserveByCoinType } from "../../src/lib/suilend/const";

const USDC_COIN_TYPE = COIN_TYPES.USDC;

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

// Configuration from environment
const DEPOSIT_ASSET = process.env.LEVERAGE_DEPOSIT_COIN_TYPE || "SUI";
const DEPOSIT_AMOUNT = process.env.LEVERAGE_DEPOSIT_AMOUNT || "1"; // Human-readable
const MULTIPLIER = parseFloat(process.env.LEVERAGE_MULTIPLIER || "2");
const DRY_RUN_ONLY = process.env.DRY_RUN_ONLY !== "false"; // Default to true for safety

async function main() {
  console.log("═".repeat(60));
  console.log(
    `  Scallop Leverage Strategy - ${DRY_RUN_ONLY ? "DRY RUN" : "EXECUTION"}`,
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

  const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 2. Resolve deposit asset
  let depositCoinType: string;
  if (DEPOSIT_ASSET.startsWith("0x") || DEPOSIT_ASSET.includes("::")) {
    depositCoinType = normalizeCoinType(DEPOSIT_ASSET);
  } else {
    depositCoinType =
      COIN_TYPES[DEPOSIT_ASSET.toUpperCase() as keyof typeof COIN_TYPES] ||
      COIN_TYPES.SUI;
  }

  const reserve = getReserveByCoinType(depositCoinType);
  const decimals = reserve?.decimals || 9;
  const symbol = reserve?.symbol || "SUI";
  const coinName = getCoinName(depositCoinType);
  const isSui = depositCoinType.endsWith("::sui::SUI");

  // 3. Calculate leverage amounts
  const depositPrice = await getTokenPrice(depositCoinType);
  const depositAmountHuman = parseFloat(DEPOSIT_AMOUNT);
  const depositAmountRaw = parseUnits(DEPOSIT_AMOUNT, decimals);
  const initialEquityUsd = depositAmountHuman * depositPrice;

  const flashLoanUsd = initialEquityUsd * (MULTIPLIER - 1);
  const flashLoanUsdc = BigInt(Math.ceil(flashLoanUsd * 1e6 * 1.02));

  const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
  const repaymentAmount = flashLoanUsdc + flashLoanFee;

  // Borrow fee is ~0.1%, add 0.3% buffer
  const borrowFeeBuffer = 1.003;
  const borrowAmount = BigInt(
    Math.ceil(Number(repaymentAmount) * borrowFeeBuffer),
  );

  const totalPositionUsd = initialEquityUsd * MULTIPLIER;
  const debtUsd = Number(repaymentAmount) / 1e6;
  const ltvPercent = (debtUsd / totalPositionUsd) * 100;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`📋 Leverage Parameters:`);
  console.log("─".repeat(60));
  console.log(`  Protocol:       Scallop`);
  console.log(`  Deposit Asset:  ${symbol} (${coinName})`);
  console.log(`  Deposit Amount: ${DEPOSIT_AMOUNT} ${symbol}`);
  console.log(`  Multiplier:     ${MULTIPLIER}x`);
  console.log(
    `  Mode:           ${DRY_RUN_ONLY ? "🟡 DRY RUN" : "🔴 REAL EXECUTION"}`,
  );

  console.log(`\n${"─".repeat(60)}`);
  console.log(`📊 Leverage Preview:`);
  console.log("─".repeat(60));
  console.log(`  Initial Equity:    $${initialEquityUsd.toFixed(2)}`);
  console.log(`  Flash Loan USDC:   ${formatUnits(flashLoanUsdc, 6)} USDC`);
  console.log(`  Flash Loan Fee:    ${formatUnits(flashLoanFee, 6)} USDC`);
  console.log(`  Borrow Amount:     ${formatUnits(borrowAmount, 6)} USDC`);
  console.log(`  Total Position:    $${totalPositionUsd.toFixed(2)}`);
  console.log(`  Total Debt:        $${debtUsd.toFixed(2)}`);
  console.log(`  LTV:               ${ltvPercent.toFixed(2)}%`);

  // Safety check
  if (ltvPercent > 70) {
    console.error(
      `\n⚠️  WARNING: High LTV detected (${ltvPercent.toFixed(1)}%). Proceed with caution!`,
    );
  }

  // 4. Initialize Scallop SDK
  console.log(`\n🔄 Initializing Scallop SDK...`);
  const scallop = new Scallop({
    secretKey: secretKey,
    networkType: "mainnet",
  });
  await scallop.init();

  const builder = await scallop.createScallopBuilder();
  const tx = builder.createTxBlock();
  tx.setSender(userAddress);

  try {
    // 5. Get swap quote
    console.log(`\n🔍 Fetching swap quote: USDC → ${symbol}...`);
    const swapQuotes = await metaAg.quote({
      amountIn: flashLoanUsdc.toString(),
      coinTypeIn: USDC_COIN_TYPE,
      coinTypeOut: depositCoinType,
    });

    if (swapQuotes.length === 0) {
      console.error(`⚠️  No swap quotes found for USDC → ${symbol}`);
      return;
    }

    const bestQuote = swapQuotes.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut),
    )[0];
    const expectedSwapOutput = BigInt(bestQuote.amountOut);
    console.log(
      `  Expected output: ${formatUnits(expectedSwapOutput, decimals)} ${symbol}`,
    );

    // 6. Build transaction
    console.log(`\n🔧 Building transaction...`);

    // Step 1: Flash loan USDC
    console.log(`  Step 1: Flash loan ${formatUnits(flashLoanUsdc, 6)} USDC`);
    const [loanCoin, receipt] = await tx.borrowFlashLoan(
      Number(flashLoanUsdc),
      "usdc",
    );

    // Step 2: Swap USDC → deposit asset
    console.log(`  Step 2: Swap USDC → ${symbol}`);
    const swappedAsset = await metaAg.swap(
      {
        quote: bestQuote,
        signer: userAddress,
        coinIn: loanCoin,
        tx: tx.txBlock,
      },
      100, // slippage
    );

    // Step 3: Prepare user's deposit
    console.log(`  Step 3: Prepare ${DEPOSIT_AMOUNT} ${symbol} from user`);
    let depositCoin: any;
    if (isSui) {
      const [userDeposit] = tx.splitSUIFromGas([Number(depositAmountRaw)]);
      tx.mergeCoins(userDeposit, [swappedAsset]);
      depositCoin = userDeposit;
    } else {
      const userCoins = await suiClient.getCoins({
        owner: userAddress,
        coinType: depositCoinType,
      });

      if (userCoins.data.length === 0) {
        throw new Error(`No ${symbol} coins found in wallet`);
      }

      const primaryCoin = tx.txBlock.object(userCoins.data[0].coinObjectId);
      if (userCoins.data.length > 1) {
        const otherCoins = userCoins.data
          .slice(1)
          .map((c) => tx.txBlock.object(c.coinObjectId));
        tx.mergeCoins(primaryCoin, otherCoins);
      }

      const [userContribution] = tx.splitCoins(primaryCoin, [
        Number(depositAmountRaw),
      ]);
      tx.mergeCoins(userContribution, [swappedAsset]);
      depositCoin = userContribution;
    }

    // Step 4: Create new obligation and add collateral
    console.log(`  Step 4: Create obligation and add ${symbol} as collateral`);
    const [obligation, obligationKey, obligationHotPotato] =
      tx.openObligation();
    tx.addCollateral(obligation, depositCoin, coinName);

    // Step 5: Update oracles
    console.log(`  Step 5: Update oracles for ${coinName} and usdc`);
    await tx.updateAssetPricesQuick([coinName, "usdc"]);

    // Step 6: Borrow USDC
    console.log(`  Step 6: Borrow ${formatUnits(borrowAmount, 6)} USDC`);
    const borrowedUsdc = tx.borrow(
      obligation,
      obligationKey,
      Number(borrowAmount),
      "usdc",
    );

    // Step 7: Repay flash loan
    console.log(`  Step 7: Repay flash loan`);
    await tx.repayFlashLoan(borrowedUsdc, receipt, "usdc");

    // Step 8: Finalize
    console.log(`  Step 8: Finalize obligation`);
    tx.returnObligation(obligation, obligationHotPotato);
    tx.transferObjects([obligationKey], userAddress);

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

        console.log(`\n📊 Expected Balance Changes:`);
        const changes = dryRunResult.balanceChanges || [];
        for (const change of changes) {
          const coinSymbol = change.coinType.split("::").pop();
          console.log(`   ${coinSymbol}: ${change.amount}`);
        }
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
      console.log(`\n🎉 Leverage position created successfully!`);
      console.log(
        `   Position: ${formatUnits(expectedSwapOutput + depositAmountRaw, decimals)} ${symbol}`,
      );
      console.log(`   Debt: ${formatUnits(borrowAmount, 6)} USDC`);
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
