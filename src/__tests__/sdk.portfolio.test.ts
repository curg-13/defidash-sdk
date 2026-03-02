/**
 * SDK Method: sdk.getAggregatedPortfolio()  [Integration]
 *
 * Verifies the public portfolio aggregation method with live mainnet data.
 *
 * Internal dependencies (tested separately):
 *   - protocol.getAccountPortfolio()  → each adapter's portfolio query
 *
 * Verified output fields:
 *   - Returns AccountPortfolio[] for all 3 protocols (Suilend, Navi, Scallop)
 *   - Each portfolio has valid healthFactor, netValueUsd, totalCollateralUsd, totalDebtUsd
 *   - positions[] entries have correct side, amount, apy
 *
 * Run: npx vitest run src/__tests__/sdk.portfolio.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { DefiDashSDK, LendingProtocol } from "..";
import type { AccountPortfolio } from "../types/position";

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// ── Print helpers ────────────────────────────────────────────────────────────

function printPortfolio(portfolio: AccountPortfolio): void {
  const usd = (v: number) => `$${v.toFixed(4)}`;
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  const lines = [
    `\n┌─ [${portfolio.protocol}] Portfolio ──────────────────────────────`,
    `│  Health Factor      : ${portfolio.healthFactor === Infinity ? "∞ (no debt)" : portfolio.healthFactor.toFixed(4)}`,
    `│  Net Value USD      : ${usd(portfolio.netValueUsd)}`,
    `│  Total Collateral   : ${usd(portfolio.totalCollateralUsd)}`,
    `│  Total Debt         : ${usd(portfolio.totalDebtUsd)}`,
  ];

  if (portfolio.netApy != null) {
    lines.push(`│  Net APY            : ${pct(portfolio.netApy)}`);
  }
  if (portfolio.totalAnnualNetEarningsUsd != null) {
    lines.push(`│  Annual Earnings    : ${usd(portfolio.totalAnnualNetEarningsUsd)}`);
  }

  if (portfolio.positions.length === 0) {
    lines.push(`│  Positions          : (none)`);
  } else {
    lines.push(`│  Positions (${portfolio.positions.length}):`);
    for (const p of portfolio.positions) {
      lines.push(
        `│    ${p.side.padEnd(7)} ${p.symbol.padEnd(6)} ${p.amount.toFixed(6)} (${usd(p.valueUsd)}) APY: ${pct(p.apy)}`,
      );
    }
  }

  lines.push(`└──────────────────────────────────────────────────────────\n`);
  console.log(lines.join("\n"));
}

// ── SDK Setup ────────────────────────────────────────────────────────────────

let sdk: DefiDashSDK;

const SECRET_KEY = process.env.SECRET_KEY || process.env.SUI_SECRET_KEY;

beforeAll(async () => {
  if (!SECRET_KEY) throw new Error("SECRET_KEY env is required");
  const suiClient = new SuiClient({
    url: process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet"),
  });
  const keypair = Ed25519Keypair.fromSecretKey(SECRET_KEY as any);
  sdk = await DefiDashSDK.create(suiClient, keypair);

  console.log(
    `\nWallet: ${keypair.getPublicKey().toSuiAddress()}\n`,
  );
}, 60_000);

// ── Shared assertions ────────────────────────────────────────────────────────

function assertValidPortfolio(portfolio: AccountPortfolio) {
  // Must have a valid protocol
  expect(Object.values(LendingProtocol)).toContain(portfolio.protocol);

  // Address must be non-empty
  expect(portfolio.address).toBeTruthy();

  // Health factor: positive number or Infinity
  expect(portfolio.healthFactor).toBeGreaterThan(0);

  // USD values must be non-negative
  expect(portfolio.netValueUsd).toBeGreaterThanOrEqual(0);
  expect(portfolio.totalCollateralUsd).toBeGreaterThanOrEqual(0);
  expect(portfolio.totalDebtUsd).toBeGreaterThanOrEqual(0);

  // Net value = collateral - debt (approximate)
  if (portfolio.totalCollateralUsd > 0 || portfolio.totalDebtUsd > 0) {
    expect(portfolio.netValueUsd).toBeCloseTo(
      portfolio.totalCollateralUsd - portfolio.totalDebtUsd,
      1,
    );
  }

  // Positions array
  expect(Array.isArray(portfolio.positions)).toBe(true);

  for (const pos of portfolio.positions) {
    expect(pos.symbol).toBeTruthy();
    expect(pos.coinType).toContain("::");
    expect(["supply", "borrow"]).toContain(pos.side);
    expect(pos.valueUsd).toBeGreaterThanOrEqual(0);
    expect(typeof pos.apy).toBe("number");
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sdk.getAggregatedPortfolio()", () => {
  it("returns portfolios for all 3 protocols", async () => {
    const portfolios = await sdk.getAggregatedPortfolio();

    expect(portfolios).toHaveLength(3);

    for (const portfolio of portfolios) {
      printPortfolio(portfolio);
      assertValidPortfolio(portfolio);
    }
  }, 60_000);

  it("always includes all protocols even with no positions", async () => {
    const portfolios = await sdk.getAggregatedPortfolio();

    const protocols = portfolios.map((p) => p.protocol);
    expect(protocols).toContain(LendingProtocol.Suilend);
    expect(protocols).toContain(LendingProtocol.Navi);
    expect(protocols).toContain(LendingProtocol.Scallop);
  }, 60_000);

  it("does not return duplicate protocols", async () => {
    const portfolios = await sdk.getAggregatedPortfolio();

    const protocols = portfolios.map((p) => p.protocol);
    const unique = new Set(protocols);
    expect(unique.size).toBe(protocols.length);
  }, 60_000);

  it("empty protocol returns safe defaults", async () => {
    const portfolios = await sdk.getAggregatedPortfolio();

    for (const portfolio of portfolios) {
      if (portfolio.positions.length === 0) {
        // Protocol with no positions should have zero values
        expect(portfolio.totalCollateralUsd).toBe(0);
        expect(portfolio.totalDebtUsd).toBe(0);
        expect(portfolio.netValueUsd).toBe(0);
        // Health factor should be Infinity (no debt risk)
        expect(portfolio.healthFactor).toBe(Infinity);
      }
    }
  }, 60_000);
});
