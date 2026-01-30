/**
 * Scallop - Create Empty Obligation
 *
 * Creates a new Scallop obligation for the user.
 * This is required before first leverage if no obligation exists.
 *
 * Run with: npm run script:scallop-create-obligation
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.scripts" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

// Scallop Core IDs
const SCALLOP_CORE = {
    protocolPkg: "0xd384ded6b9e7f4d2c4c9007b0291ef88fbfed8e709bce83d2da69de2d79d013d",
    version: "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7",
};

async function main() {
    console.log("═".repeat(60));
    console.log("  Scallop - Create Empty Obligation");
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

    const address = keypair.getPublicKey().toSuiAddress();
    console.log(`\n📍 Wallet: ${address}`);

    const client = new SuiClient({ url: getFullnodeUrl("mainnet") });

    // 2. Build transaction
    console.log("\n🔄 Building obligation creation transaction...");
    const tx = new Transaction();
    tx.setSender(address);
    tx.setGasBudget(10_000_000);

    // Open obligation -> returns [obligation, obligationKey, hotPotato]
    const result = tx.moveCall({
        target: `${SCALLOP_CORE.protocolPkg}::open_obligation::open_obligation`,
        arguments: [tx.object(SCALLOP_CORE.version)],
    });

    const obligation = result[0];
    const obligationKey = result[1];
    const hotPotato = result[2];

    // Return obligation (consume hot potato)
    tx.moveCall({
        target: `${SCALLOP_CORE.protocolPkg}::open_obligation::return_obligation`,
        arguments: [
            tx.object(SCALLOP_CORE.version),
            obligation,
            hotPotato,
        ],
    });

    // Transfer obligation key to user
    tx.transferObjects([obligationKey], address);

    // 3. Dry run first
    console.log("\n🧪 Running dry-run...");
    const dryRunResult = await client.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client }),
    });

    if (dryRunResult.effects.status.status === "failure") {
        console.error("❌ Dry-run failed:", dryRunResult.effects.status.error);
        return;
    }

    console.log("✅ Dry-run successful!");
    console.log(`  Gas estimate: ${dryRunResult.effects.gasUsed.computationCost} MIST`);

    // 4. Ask for confirmation
    const DRY_RUN_ONLY = process.env.DRY_RUN_ONLY !== "false";

    if (DRY_RUN_ONLY) {
        console.log("\n⚠️  DRY RUN ONLY mode. Set DRY_RUN_ONLY=false to execute.");
        console.log("═".repeat(60));
        return;
    }

    // 5. Execute
    console.log("\n🚀 Executing transaction...");
    const execResult = await client.signAndExecuteTransaction({
        signer: keypair,
        transaction: tx,
        options: { showEffects: true, showObjectChanges: true },
    });

    if (execResult.effects?.status.status === "success") {
        console.log("✅ Obligation created successfully!");
        console.log(`  Digest: ${execResult.digest}`);

        // Find created objects
        const createdObjects = execResult.objectChanges?.filter(
            (c) => c.type === "created"
        );

        if (createdObjects) {
            console.log("\n📦 Created Objects:");
            for (const obj of createdObjects) {
                if (obj.type === "created") {
                    console.log(`  - ${obj.objectType}`);
                    console.log(`    ID: ${obj.objectId}`);
                }
            }
        }
    } else {
        console.error("❌ Transaction failed:", execResult.effects?.status.error);
    }

    console.log("\n" + "═".repeat(60));
    console.log("  Done!");
    console.log("═".repeat(60));
}

main().catch(console.error);
