/**
 * DefiDash SDK - Portfolio Comparison
 *
 * Fetches and compares portfolio across all supported protocols
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DefiDashSDK, LendingProtocol, AccountPortfolio } from "../src";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

const protocols: [LendingProtocol, string][] = [
  [LendingProtocol.Suilend, "Suilend"],
  [LendingProtocol.Navi, "Navi"],
  [LendingProtocol.Scallop, "Scallop"],
];

interface PortfolioResult {
  protocol: string;
  success: boolean;
  portfolio?: AccountPortfolio;
  error?: string;
}

function formatUsd(value: number | undefined): string {
  if (value === undefined) return "--";
  return `$${value.toFixed(2)}`;
}

function formatPercent(value: number | undefined): string {
  if (value === undefined) return "--";
  return `${value.toFixed(2)}%`;
}

function formatHealthFactor(value: number | undefined): string {
  if (value === undefined || value === Infinity) return "Safe";
  if (value < 1.0) return `${value.toFixed(2)} ⚠️`;
  if (value < 1.5) return `${value.toFixed(2)} ⚡`;
  return value.toFixed(2);
}

async function fetchPortfolio(
  sdk: DefiDashSDK,
  protocol: LendingProtocol,
  protocolName: string,
  address: string,
): Promise<PortfolioResult> {
  try {
    const adapter = (sdk as any).protocols.get(protocol);
    if (!adapter) {
      return {
        protocol: protocolName,
        success: false,
        error: "Protocol not initialized",
      };
    }

    const portfolio = await adapter.getAccountPortfolio(address);

    return {
      protocol: protocolName,
      success: true,
      portfolio,
    };
  } catch (error: any) {
    return {
      protocol: protocolName,
      success: false,
      error: error.message,
    };
  }
}

function printSummaryTable(results: PortfolioResult[]) {
  console.log(
    "\n┌────────────┬───────────────┬───────────────┬───────────────┬──────────────┬────────────┐",
  );
  console.log(
    "│ Protocol   │ Net Value     │ Deposited     │ Debt          │ Health       │ Net APY    │",
  );
  console.log(
    "├────────────┼───────────────┼───────────────┼───────────────┼──────────────┼────────────┤",
  );

  for (const result of results) {
    if (result.success && result.portfolio) {
      const p = result.portfolio;
      console.log(
        `│ ${result.protocol.padEnd(10)} │ ${formatUsd(p.netValueUsd).padStart(13)} │ ${formatUsd(p.totalDepositedUsd).padStart(13)} │ ${formatUsd(p.totalDebtUsd).padStart(13)} │ ${formatHealthFactor(p.healthFactor).padStart(12)} │ ${formatPercent(p.netApy).padStart(10)} │`,
      );
    } else {
      console.log(
        `│ ${result.protocol.padEnd(10)} │ ${"ERROR".padStart(13)} │ ${"--".padStart(13)} │ ${"--".padStart(13)} │ ${"--".padStart(12)} │ ${"--".padStart(10)} │`,
      );
    }
  }

  console.log(
    "└────────────┴───────────────┴───────────────┴───────────────┴──────────────┴────────────┘",
  );
}

function printTotals(results: PortfolioResult[]) {
  const successResults = results.filter((r) => r.success && r.portfolio);

  const totals = successResults.reduce(
    (acc, r) => {
      const p = r.portfolio!;
      acc.netValue += p.netValueUsd || 0;
      acc.deposited += p.totalDepositedUsd || 0;
      acc.debt += p.totalDebtUsd || 0;
      acc.annualEarnings += p.totalAnnualNetEarningsUsd || 0;
      return acc;
    },
    { netValue: 0, deposited: 0, debt: 0, annualEarnings: 0 },
  );

  console.log("\nAggregated Totals:");
  console.log("─".repeat(50));
  console.log(`  Total Net Value:      ${formatUsd(totals.netValue)}`);
  console.log(`  Total Deposited:      ${formatUsd(totals.deposited)}`);
  console.log(`  Total Debt:           ${formatUsd(totals.debt)}`);
  console.log(`  Annual Net Earnings:  ${formatUsd(totals.annualEarnings)}`);
}

function printPositionDetails(results: PortfolioResult[]) {
  for (const result of results) {
    if (!result.success || !result.portfolio) continue;

    const p = result.portfolio;
    if (p.positions.length === 0) continue;

    console.log(`\n${result.protocol} Positions:`);
    console.log("─".repeat(80));

    console.table(
      p.positions.map((pos) => ({
        Symbol: pos.symbol,
        Side: pos.side,
        Amount: pos.amount.toFixed(6),
        ValueUSD: formatUsd(pos.valueUsd),
        APY: formatPercent(pos.apy * 100),
        Rewards:
          pos.rewards
            ?.map((r) => `${r.amount.toFixed(4)} ${r.symbol}`)
            .join(", ") || "-",
        LiqPrice: pos.estimatedLiquidationPrice
          ? formatUsd(pos.estimatedLiquidationPrice)
          : "-",
      })),
    );
  }
}

async function main() {
  console.log(
    "═══════════════════════════════════════════════════════════════════════════════",
  );
  console.log("  Portfolio Comparison - All Protocols");
  console.log(
    "═══════════════════════════════════════════════════════════════════════════════\n",
  );

  // Setup
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey || secretKey === "YOUR_SECRET_KEY_HERE") {
    console.error("Error: SECRET_KEY not found in .env file.");
    return;
  }

  const suiClient = new SuiClient({ url: SUI_FULLNODE_URL });
  const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
  const address = keypair.getPublicKey().toSuiAddress();

  console.log(`Wallet: ${address}\n`);

  // Initialize SDK
  const sdk = await DefiDashSDK.create(suiClient, keypair);
  console.log("SDK initialized.\n");

  const results: PortfolioResult[] = [];

  // Fetch portfolio from each protocol
  console.log("Fetching portfolios...");
  for (const [protocol, protocolName] of protocols) {
    process.stdout.write(`  ${protocolName}... `);
    const result = await fetchPortfolio(sdk, protocol, protocolName, address);
    results.push(result);

    if (result.success) {
      console.log("OK");
    } else {
      console.log(`Error: ${result.error}`);
    }
  }

  // Print summary table
  console.log(
    "\n═══════════════════════════════════════════════════════════════════════════════",
  );
  console.log("  Portfolio Summary");
  console.log(
    "═══════════════════════════════════════════════════════════════════════════════",
  );

  printSummaryTable(results);
  printTotals(results);

  // Print position details if any exist
  const hasPositions = results.some(
    (r) => r.success && r.portfolio && r.portfolio.positions.length > 0,
  );

  if (hasPositions) {
    console.log(
      "\n═══════════════════════════════════════════════════════════════════════════════",
    );
    console.log("  Position Details");
    console.log(
      "═══════════════════════════════════════════════════════════════════════════════",
    );

    printPositionDetails(results);
  }

  // Summary
  const passed = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log(
    "\n═══════════════════════════════════════════════════════════════════════════════",
  );
  console.log(`  Fetched: ${passed}/${protocols.length} protocols`);
  if (failed > 0) {
    console.log(`  Failed: ${results.filter((r) => !r.success).map((r) => r.protocol).join(", ")}`);
  }
  console.log(
    "═══════════════════════════════════════════════════════════════════════════════\n",
  );
}

main().catch(console.error);
