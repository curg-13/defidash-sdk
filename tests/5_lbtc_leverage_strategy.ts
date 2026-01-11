import * as dotenv from "dotenv";
dotenv.config(); // Load SECRET_KEY from .env
dotenv.config({ path: ".env.public" }); // Load other configs from .env.public
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { MetaAg, getTokenPrice } from "@7kprotocol/sdk-ts";
import { ScallopFlashLoanClient } from "../src/lib/scallop";
import { getReserveByCoinType } from "../src/lib/const";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

// Configurable via .env
const DEPOSIT_COIN_TYPE =
  process.env.DEPOSIT_COIN_TYPE ||
  "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC";
const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

function normalizeCoinType(coinType: string) {
  const parts = coinType.split("::");
  if (parts.length !== 3) return coinType;
  let pkg = parts[0].replace("0x", "");
  pkg = pkg.padStart(64, "0");
  return `0x${pkg}::${parts[1]}::${parts[2]}`;
}

function formatUnits(
  amount: string | number | bigint,
  decimals: number
): string {
  const s = amount.toString();
  if (decimals === 0) return s;
  const pad = s.padStart(decimals + 1, "0");
  const transition = pad.length - decimals;
  return (
    `${pad.slice(0, transition)}.${pad.slice(transition)}`.replace(
      /\.?0+$/,
      ""
    ) || "0"
  );
}

async function main() {
  console.log("--- LBTC Leverage Strategy with Flash Loan ---");
  console.log(
    "⚠️  WARNING: This script will calculate required flash loan amount!\n"
  );

  // 1. Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("Error: SECRET_KEY not found in .env file.");
    return;
  }
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const userAddress = keypair.getPublicKey().toSuiAddress();
  console.log(`Using Wallet Address: ${userAddress}`);

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const flashLoanClient = new ScallopFlashLoanClient();
  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    suiClient
  );
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 2. Get asset info
  const normalizedCoinType = normalizeCoinType(DEPOSIT_COIN_TYPE);
  const reserve = getReserveByCoinType(normalizedCoinType);
  const decimals = reserve?.decimals || 8;
  const symbol = reserve?.symbol || "LBTC";

  // 3. Parameters
  const initialEquity = BigInt(process.env.DEPOSIT_AMOUNT || "1101"); // Raw units
  const multiplier = parseFloat(process.env.MULTIPLIER || "1.5");
  const LTV = 0.6; // LBTC LTV on Suilend (60%)
  const maxMultiplier = 1 / (1 - LTV); // 2.5x for 60% LTV

  // Get current prices
  const assetPrice = await getTokenPrice(normalizedCoinType);
  const initialEquityHuman = Number(initialEquity) / Math.pow(10, decimals);
  const initialEquityUsd = initialEquityHuman * assetPrice;

  console.log(`\n📊 Initial Position:`);
  console.log(`─`.repeat(50));
  console.log(`  Asset:              ${symbol}`);
  console.log(
    `  Initial Equity:     ${formatUnits(initialEquity, decimals)} ${symbol}`
  );
  console.log(`  Asset Price:        $${assetPrice.toLocaleString()}`);
  console.log(`  Equity Value:       ~$${initialEquityUsd.toFixed(2)}`);
  console.log(`  LTV:                ${(LTV * 100).toFixed(0)}%`);
  console.log(`  Max Multiplier:     ${maxMultiplier.toFixed(2)}x`);
  console.log(`  Target Multiplier:  ${multiplier}x`);
  console.log(`─`.repeat(50));

  if (multiplier > maxMultiplier) {
    console.error(
      `\n❌ Error: Multiplier ${multiplier}x exceeds max ${maxMultiplier.toFixed(
        2
      )}x for ${LTV * 100}% LTV!`
    );
    return;
  }

  try {
    // 4. Calculate required flash loan amount
    // Total Position = Initial Equity * Multiplier
    // Flash Loan = Total Position - Initial Equity = Initial Equity * (Multiplier - 1)
    const leverageAmount = BigInt(
      Math.floor(Number(initialEquity) * (multiplier - 1))
    );
    const leverageAmountHuman = Number(leverageAmount) / Math.pow(10, decimals);
    const leverageUsd = leverageAmountHuman * assetPrice;

    // Total position after leverage
    const totalPosition = initialEquity + leverageAmount;
    const totalPositionHuman = Number(totalPosition) / Math.pow(10, decimals);
    const totalPositionUsd = totalPositionHuman * assetPrice;

    // Debt = Flash Loan Amount (in USDC)
    const debtUsd = leverageUsd;

    // Net Worth = Total Position - Debt
    const netWorthUsd = totalPositionUsd - debtUsd;

    // Actual LTV after leverage
    const actualLtv = debtUsd / totalPositionUsd;

    // Calculate liquidation price
    // Liquidation happens when: (Collateral Value * LTV) <= Debt
    // Asset Price * Total Position * LTV = Debt
    // Liquidation Price = Debt / (Total Position * LTV)
    const liquidationPrice = debtUsd / (totalPositionHuman * LTV);

    console.log(`\n📈 Leverage Position Preview:`);
    console.log(`─`.repeat(50));
    console.log(
      `  Flash Loan needed:  ${formatUnits(
        leverageAmount,
        decimals
      )} ${symbol} (~$${leverageUsd.toFixed(2)} USDC)`
    );
    console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(
      `  Total Collateral:   ${formatUnits(
        totalPosition,
        decimals
      )} ${symbol} (~$${totalPositionUsd.toFixed(2)})`
    );
    console.log(`  Total Debt:         $${debtUsd.toFixed(2)} USDC`);
    console.log(
      `  Net Worth:          $${netWorthUsd.toFixed(2)} (Collateral - Debt)`
    );
    console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(
      `  Actual Leverage:    ${(totalPositionUsd / netWorthUsd).toFixed(2)}x`
    );
    console.log(`  Position LTV:       ${(actualLtv * 100).toFixed(1)}%`);
    console.log(
      `  Liquidation Price:  $${liquidationPrice.toLocaleString(undefined, {
        maximumFractionDigits: 0,
      })}`
    );
    console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(
      `  Price Drop Buffer:  ${(
        (1 - liquidationPrice / assetPrice) *
        100
      ).toFixed(1)}% before liquidation`
    );
    console.log(`─`.repeat(50));

    // 5. Get quote for swap: USDC -> LBTC
    console.log(`\n🔄 Getting swap quote: USDC -> ${symbol}...`);
    const usdcAmount = Math.ceil(leverageUsd * 1e6); // USDC has 6 decimals, add buffer
    const swapQuotes = await metaAg.quote({
      amountIn: (usdcAmount * 1.02).toString(), // 2% buffer for slippage
      coinTypeIn: USDC_COIN_TYPE,
      coinTypeOut: normalizedCoinType,
    });

    if (swapQuotes.length === 0) {
      console.log(`\n⚠️  No swap quotes found for USDC -> ${symbol}`);
      console.log(`   This pair might not have enough liquidity.`);
      return;
    }

    const bestQuote = swapQuotes.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut)
    )[0];

    const flashLoanUsdc = BigInt(Math.ceil(usdcAmount * 1.02));
    const expectedOutput = Number(bestQuote.amountOut) / Math.pow(10, decimals);

    console.log(`  Flash Loan USDC:    ${formatUnits(flashLoanUsdc, 6)} USDC`);
    console.log(
      `  Expected ${symbol}:     ~${expectedOutput.toFixed(8)} ${symbol}`
    );

    console.log(`\n✅ Position calculation complete!`);
    console.log(
      `\n💡 To execute this leverage position, uncomment the transaction code below.`
    );

    // Uncomment below to execute
    /*
    const tx = new Transaction();
    tx.setSender(userAddress);

    // A. Flash loan USDC (빌리는 금액 = leverage에 필요한 USDC)
    const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(tx, flashLoanUsdc, "usdc");

    // B. Swap USDC → LBTC (빌린 USDC로 LBTC 구매)
    const swappedAsset = await metaAg.swap({
      quote: bestQuote,
      signer: userAddress,
      coinIn: loanCoin,
      tx: tx,
    }, 100);

    // C. Get existing or create obligation
    const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      suiClient
    );
    const existingCap = obligationOwnerCaps[0];
    let obligationOwnerCapId: string;
    let obligationId: string;

    if (existingCap) {
      obligationOwnerCapId = existingCap.id;
      obligationId = existingCap.obligationId;
    } else {
      const newCap = suilendClient.createObligation(tx);
      obligationOwnerCapId = newCap as any;
      obligationId = "";
    }

    // D. Get user's existing LBTC coins and merge with swapped LBTC
    // 유저의 기존 LBTC 코인 가져오기
    const userCoins = await suiClient.getCoins({
      owner: userAddress,
      coinType: normalizedCoinType,
    });

    if (userCoins.data.length === 0) {
      throw new Error("No LBTC coins found in wallet!");
    }

    // Primary coin (첫 번째 코인을 기준으로)
    const primaryCoin = tx.object(userCoins.data[0].coinObjectId);
    
    // Merge other coins if any (여러 코인이 있으면 합침)
    if (userCoins.data.length > 1) {
      const otherCoins = userCoins.data.slice(1).map(c => tx.object(c.coinObjectId));
      tx.mergeCoins(primaryCoin, otherCoins);
    }

    // Merge swapped LBTC with user's LBTC
    // 스왑해서 받은 LBTC를 유저의 기존 LBTC에 병합
    tx.mergeCoins(primaryCoin, [swappedAsset]);

    // E. Deposit all LBTC (초기 LBTC $1 + 스왑한 LBTC $0.5 = 총 $1.5)
    suilendClient.deposit(primaryCoin, normalizedCoinType, obligationOwnerCapId, tx);

    // F. Borrow USDC to repay flash loan (담보 대비 $0.5 USDC 대출)
    const borrowedUsdc = await suilendClient.borrow(
      obligationOwnerCapId,
      obligationId || "0x0",
      USDC_COIN_TYPE,
      flashLoanUsdc.toString(),
      tx,
      !existingCap ? false : true
    );

    // G. Repay flash loan with borrowed USDC
    flashLoanClient.repayFlashLoan(tx, borrowedUsdc[0] as any, receipt, "usdc");

    // H. Execute transaction
    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    if (result.effects?.status.status === "success") {
      console.log("✅ Leverage position created successfully!");
      console.log(`📋 Transaction Digest: ${result.digest}`);
      console.log(`\n📊 Final Position:`);
      console.log(`   - Collateral: ~$${totalPositionUsd.toFixed(2)} ${symbol}`);
      console.log(`   - Debt: ~$${debtUsd.toFixed(2)} USDC`);
      console.log(`   - Leverage: ${multiplier}x`);
    } else {
      console.error("❌ Transaction failed:", result.effects?.status.error);
    }
    */
  } catch (error: any) {
    console.error("\nERROR:", error.message || error);
  }
}

main();
