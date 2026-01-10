import "dotenv/config";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import {
  SuilendClient,
  LENDING_MARKET_ID,
  LENDING_MARKET_TYPE,
} from "@suilend/sdk";
import { MetaAg } from "@7kprotocol/sdk-ts";
import { ScallopBuilder } from "../src/lib/scallop";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");
const SUI_COIN_TYPE = "0x2::sui::SUI";
const USDC_COIN_TYPE =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";

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
  console.log("--- Leverage Strategy: long SUI with USDC Flashloan ---");

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

  // Initialize our custom Scallop Builder (no SDK dependency!)
  const scallopBuilder = new ScallopBuilder({
    client: suiClient,
    signer: keypair,
  });

  const suilendClient = await SuilendClient.initialize(
    LENDING_MARKET_ID,
    LENDING_MARKET_TYPE,
    suiClient
  );
  const metaAg = new MetaAg({
    partner:
      "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf",
  });

  // 2. Parameters
  const initialEquitySui = BigInt(process.env.DEPOSIT_AMOUNT || "500000000"); // 0.5 SUI
  const multiplier = parseFloat(process.env.MULTIPLIER || "1.5");
  const leverageSuiAmount = BigInt(
    Math.floor(Number(initialEquitySui) * (multiplier - 1))
  );

  console.log(`\nParameters:`);
  console.log(`- Initial Equity: ${formatUnits(initialEquitySui, 9)} SUI`);
  console.log(`- Multiplier: ${multiplier}x`);
  console.log(
    `- Target Leverage Amount: ${formatUnits(leverageSuiAmount, 9)} SUI`
  );
  console.log(`- Flash Loan Fee: 0% (Scallop currently charges no fee)`);

  try {
    // 3. Estimate Flashloan Amount (SUI -> USDC)
    console.log("\nEstimating required USDC flashloan...");
    const quotesForLoan = await metaAg.quote({
      amountIn: leverageSuiAmount.toString(),
      coinTypeIn: SUI_COIN_TYPE,
      coinTypeOut: USDC_COIN_TYPE,
    });

    if (quotesForLoan.length === 0)
      throw new Error("No quotes found for SUI -> USDC");
    const quoteForLoan = quotesForLoan.sort(
      (a, b) => Number(b.amountOut) - Number(a.amountOut)
    )[0];

    // Adding a 2% buffer for slippage and fees
    const flashloanAmount = BigInt(
      Math.floor(Number(quoteForLoan.amountOut) * 1.02)
    );
    console.log(
      `Estimated USDC needed: ${formatUnits(flashloanAmount, 6)} USDC`
    );

    // 4. Create Transaction using Scallop Builder pattern
    const scallopTxBlock = scallopBuilder.createTxBlock();
    scallopTxBlock.setSender(userAddress);
    const suiTxBlock = scallopTxBlock.txBlock; // Access underlying Transaction

    // IMPORTANT: Refresh Suilend oracle prices FIRST (before any operations)
    // This must be the first operation in the PTB to avoid stale oracle errors
    console.log("\nStep 0: Refreshing Suilend oracle prices...");
    const obligationOwnerCaps = await SuilendClient.getObligationOwnerCaps(
      userAddress,
      [LENDING_MARKET_TYPE],
      suiClient
    );
    const existingObligationOwnerCap = obligationOwnerCaps[0];
    let obligation: any = null;
    let obligationOwnerCapId: any;
    let obligationId: string;

    if (existingObligationOwnerCap) {
      obligationOwnerCapId = existingObligationOwnerCap.id;
      obligationId = existingObligationOwnerCap.obligationId;
      obligation = await SuilendClient.getObligation(
        obligationId,
        [LENDING_MARKET_TYPE],
        suiClient
      );
      await suilendClient.refreshAll(suiTxBlock, obligation);
      console.log(`- Using existing Obligation ID: ${obligationId}`);
    } else {
      console.log("- No existing obligation found, creating new one in PTB...");
      const newObligationOwnerCap = suilendClient.createObligation(suiTxBlock);
      obligationOwnerCapId = newObligationOwnerCap as any;
      obligationId = "";
      await suilendClient.refreshAll(suiTxBlock, null as any, [
        SUI_COIN_TYPE,
        USDC_COIN_TYPE,
      ]);
    }

    // A. Flash loan USDC from Scallop
    console.log(
      `\nStep 1: Scallop Flashloan ${formatUnits(flashloanAmount, 6)} USDC...`
    );
    const [loanCoin, receipt] = scallopTxBlock.borrowFlashLoan(
      flashloanAmount,
      "usdc"
    );

    // B. Swap USDC to SUI via 7k-SDK
    console.log("Step 2: 7k-SDK Swap USDC -> SUI...");
    const swapQuotes = await metaAg.quote({
      amountIn: flashloanAmount.toString(),
      coinTypeIn: USDC_COIN_TYPE,
      coinTypeOut: SUI_COIN_TYPE,
    });

    const bestSwapQuote = swapQuotes.sort(
      (a, b) =>
        Number(b.simulatedAmountOut || b.amountOut) -
        Number(a.simulatedAmountOut || a.amountOut)
    )[0];

    const swappedSui = await metaAg.swap(
      {
        quote: bestSwapQuote,
        signer: userAddress,
        coinIn: loanCoin,
        tx: suiTxBlock, // Use underlying Transaction for 7k-SDK
      },
      100
    ); // 1% slippage

    // C. Suilend Operations
    console.log("Step 3: Suilend Deposit & Borrow...");
    // Get user's existing equity SUI from gas coin
    const userSui = suiTxBlock.splitCoins(suiTxBlock.gas, [
      suiTxBlock.pure.u64(initialEquitySui),
    ]);

    // Merge with swapped SUI
    suiTxBlock.mergeCoins(userSui, [swappedSui]);

    // Calculate total deposit amount
    const totalDepositAmount = initialEquitySui + leverageSuiAmount;
    console.log(
      `- Total SUI to deposit: ~${formatUnits(totalDepositAmount, 9)} SUI`
    );

    // Refresh oracle prices again right before deposit
    // (Swap operations may have triggered oracle staleness check)
    if (obligation) {
      await suilendClient.refreshAll(suiTxBlock, obligation);
    } else {
      await suilendClient.refreshAll(suiTxBlock, null as any, [
        SUI_COIN_TYPE,
        USDC_COIN_TYPE,
      ]);
    }

    // Deposit the merged SUI coin into Suilend obligation
    // Using suilendClient.deposit() which handles:
    // 1. Depositing liquidity and minting cTokens
    // 2. Depositing cTokens into the obligation
    suilendClient.deposit(
      userSui,
      SUI_COIN_TYPE,
      obligationOwnerCapId,
      suiTxBlock
    );

    // Borrow USDC to repay flashloan (addRefreshCalls=false since we already refreshed)
    console.log(
      `- Borrowing ${formatUnits(flashloanAmount, 6)} USDC to repay flash loan`
    );
    const borrowedUsdc = await suilendClient.borrow(
      obligationOwnerCapId,
      obligationId || "0x0", // Dummy ID for new obligations
      USDC_COIN_TYPE,
      flashloanAmount.toString(),
      suiTxBlock,
      false // addRefreshCalls=false since we already called refreshAll before deposit
    );

    // D. Repay Flashloan
    console.log("Step 4: Repay Scallop Flashloan...");
    // borrowedUsdc is a TransactionResult array [coin], extract the first element
    scallopTxBlock.repayFlashLoan(borrowedUsdc[0] as any, receipt, "usdc");

    // 5. Dry Run
    console.log("\nExecuting dry-run...");
    const dryRunResult = await scallopBuilder.dryRunTxBlock(scallopTxBlock);

    if (!dryRunResult.success) {
      console.error("❌ Dry-run failed:", dryRunResult.error);
    } else {
      console.log("✅ Dry-run successful!");
      console.log("\nNote: Real execution script is ready. Use with caution.");

      // Uncomment to execute for real:
      // const result = await scallopBuilder.signAndSendTxBlock(scallopTxBlock);
      // console.log("✅ Transaction executed! Digest:", result.digest);
    }
  } catch (error: any) {
    console.error("\nERROR:", error.message || error);
    if (error.stack) {
      console.error("Stack Trace:", error.stack);
    }
  }
}

main();
