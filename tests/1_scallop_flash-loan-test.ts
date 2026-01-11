import * as dotenv from "dotenv";
dotenv.config(); // Load SECRET_KEY from .env
dotenv.config({ path: ".env.public" }); // Load other configs from .env.public

import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { ScallopFlashLoanClient } from "../src/lib/scallop";

async function testSimpleFlashLoan() {
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

  // 2. Create Custom Flash Loan Client (uses latest protocol package by default)
  const flashLoanClient = new ScallopFlashLoanClient();

  // 3. Create Transaction
  const tx = new Transaction();
  tx.setSender(sender);

  // 4. 테스트 파라미터 설정
  const loanAmount = 1 * 10 ** 9; // 1 SUI (Mist 단위)
  const coinName = "sui";

  console.log(`Testing Flash Loan for ${loanAmount / 1e9} SUI...`);

  try {
    // 5. [Step 1] 플래시 론 빌리기
    const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(
      tx,
      loanAmount,
      coinName
    );

    /**
     * [이 지점에 나중에 스왑(Swap)이나 레버리지 로직이 들어갑니다]
     * 예시:
     * const [splitCoin] = tx.splitCoins(loanCoin, [tx.pure.u64(amount)]);
     * // ... do something with splitCoin
     */

    // 6. [Step 2] 플래시 론 갚기
    flashLoanClient.repayFlashLoan(tx, loanCoin, receipt, coinName);

    // 7. 트랜잭션 전송 및 실행
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
    console.error("❌ Flash Loan Failed:", error);
  }
}

testSimpleFlashLoan().catch((err) => {
  console.error("Unhandled error in testSimpleFlashLoan:", err);
});
