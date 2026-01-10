import "dotenv/config";

import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { ScallopFlashLoanClient } from "../src/lib/scallop";

async function testFlashLoanWithCustomClient() {
  // 1. Initial Setup
  const secretKey = process.env.SECRET_KEY;
  const SUI_FULLNODE_URL =
    process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error(
      "Please provide a valid SECRET_KEY in the script or environment variable."
    );
    return;
  }

  let keypair;
  try {
    keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  } catch (e) {
    console.error("Error creating keypair:", e);
    return;
  }

  const sender = keypair.getPublicKey().toSuiAddress();
  console.log("Sender Address:", sender);

  const client = new SuiClient({ url: SUI_FULLNODE_URL });

  // 2. Create Custom Flash Loan Client with LATEST protocol package
  // This address is from Move Registry - the latest version
  const LATEST_PROTOCOL_PKG =
    "0xd384ded6b9e7f4d2c4c9007b0291ef88fbfed8e709bce83d2da69de2d79d013d";

  console.log("\nUsing latest protocol package:", LATEST_PROTOCOL_PKG);

  const flashLoanClient = new ScallopFlashLoanClient({
    protocolPkg: LATEST_PROTOCOL_PKG,
    // version and market remain default from API
  });

  // 3. Create Transaction
  const tx = new Transaction();
  tx.setSender(sender);

  const loanAmount = 1_000_000_000; // 1 SUI
  const coinName = "sui";

  console.log(`\nTesting Flash Loan for ${loanAmount / 1e9} SUI...`);

  try {
    // 4. Borrow Flash Loan
    const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
      tx,
      loanAmount,
      coinName
    );

    /**
     * [이 지점에 스왑/레버리지 로직 추가]
     * 예: const swappedCoin = await metaAg.swap({ ... tx, coinIn: loanCoin });
     */

    // 5. Repay Flash Loan
    flashLoanClient.repayFlashLoan(tx, loanCoin, receipt, coinName);

    // 6. Dry Run first
    console.log("\nRunning dry-run...");
    const dryRunResult = await client.dryRunTransactionBlock({
      transactionBlock: await tx.build({ client }),
    });

    if (dryRunResult.effects.status.status === "failure") {
      console.error("❌ Dry-run failed:", dryRunResult.effects.status.error);
      return;
    }

    console.log("✅ Dry-run successful!");

    // 7. Execute Transaction
    console.log("\nExecuting transaction...");
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      options: { showEffects: true },
    });

    if (result.effects?.status.status === "success") {
      console.log("✅ Flash Loan Success! Digest:", result.digest);
    } else {
      console.error("❌ Flash Loan Failed:", result.effects?.status.error);
    }
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

testFlashLoanWithCustomClient().catch((err) => {
  console.error("Unhandled error:", err);
});
