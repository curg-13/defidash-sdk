/**
 * SDK Method: sdk.getPosition() / sdk.getOpenPositions()  [Integration]
 *
 * Verifies the public position query methods with live mainnet data.
 *
 * Internal dependencies (tested separately):
 *   - protocol.getPosition()  → see internal.getPosition.test.ts
 *
 * Verified output fields:
 *   - getPosition(): PositionInfo | null per protocol
 *   - getOpenPositions(): array of { protocol, position } across all protocols
 *
 * Run: npx vitest run src/__tests__/sdk.position.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env" });

import { DefiDashSDK, LendingProtocol } from "..";
import type { PositionInfo } from "../types/position";

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// ── Print helpers ────────────────────────────────────────────────────────────

function printPosition(
  protocol: string,
  position: PositionInfo | null,
): void {
  if (!position) {
    console.log(`  [${protocol}] No position`);
    return;
  }

  const usd = (v: number) => `$${v.toFixed(4)}`;
  const amt = (v: bigint, d: number) =>
    (Number(v) / Math.pow(10, d)).toFixed(6);

  const lines = [`  [${protocol}]`];
  for (const s of position.supplies) {
    lines.push(`    Supply: ${amt(s.amount, s.decimals)} ${s.symbol} (${usd(s.valueUsd)})`);
  }
  for (const b of position.borrows) {
    lines.push(`    Borrow: ${amt(b.amount, b.decimals)} ${b.symbol} (${usd(b.valueUsd)})`);
  }
  lines.push(`    Net: ${usd(position.netValueUsd)}`);
  console.log(lines.join("\n"));
}

function printOpenPositions(
  results: Array<{ protocol: LendingProtocol; position: PositionInfo }>,
): void {
  console.log(
    `\n┌─ Open Positions (${results.length} found) ──────────────────────`,
  );
  if (results.length === 0) {
    console.log(`│  No open positions across any protocol`);
  }
  for (const { protocol, position } of results) {
    printPosition(protocol, position);
  }
  console.log(`└──────────────────────────────────────────────────────────\n`);
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

function assertValidPosition(position: PositionInfo) {
  // Supplies array
  expect(Array.isArray(position.supplies)).toBe(true);
  expect(position.supplies.length).toBeGreaterThan(0);
  for (const s of position.supplies) {
    expect(s.amount).toBeGreaterThanOrEqual(0n);
    expect(s.symbol).toBeTruthy();
    expect(s.coinType).toContain("::");
    expect(s.decimals).toBeGreaterThanOrEqual(0);
    expect(s.valueUsd).toBeGreaterThanOrEqual(0);
  }

  // Borrows array
  expect(Array.isArray(position.borrows)).toBe(true);
  for (const b of position.borrows) {
    expect(b.amount).toBeGreaterThanOrEqual(0n);
    expect(b.symbol).toBeTruthy();
    expect(b.coinType).toContain("::");
    expect(b.decimals).toBeGreaterThanOrEqual(0);
    expect(b.valueUsd).toBeGreaterThanOrEqual(0);
  }

  // Primary collateral = largest supply by USD
  expect(position.collateral).toBeDefined();
  const maxSupply = [...position.supplies].sort((a, b) => b.valueUsd - a.valueUsd)[0];
  expect(position.collateral.symbol).toBe(maxSupply.symbol);

  // Primary debt = largest borrow by USD (if borrows exist)
  expect(position.debt).toBeDefined();
  if (position.borrows.length > 0) {
    const maxBorrow = [...position.borrows].sort((a, b) => b.valueUsd - a.valueUsd)[0];
    expect(position.debt.symbol).toBe(maxBorrow.symbol);
  }

  // Net value = total supplies - total borrows
  const totalSupplyUsd = position.supplies.reduce((sum, s) => sum + s.valueUsd, 0);
  const totalBorrowUsd = position.borrows.reduce((sum, b) => sum + b.valueUsd, 0);
  expect(position.netValueUsd).toBeCloseTo(totalSupplyUsd - totalBorrowUsd, 1);
}

// ── Tests: getPosition() ─────────────────────────────────────────────────────

describe("sdk.getPosition()", () => {
  it.each([
    [LendingProtocol.Suilend, "Suilend"],
    [LendingProtocol.Navi, "Navi"],
    [LendingProtocol.Scallop, "Scallop"],
  ])(
    "%s — returns null or valid PositionInfo",
    async (protocol, label) => {
      const position = await sdk.getPosition(protocol);
      printPosition(label, position);

      if (position) {
        assertValidPosition(position);
      } else {
        expect(position).toBeNull();
      }
    },
    30_000,
  );
});

// ── Tests: getOpenPositions() ────────────────────────────────────────────────

describe("sdk.getOpenPositions()", () => {
  it("returns array of active positions", async () => {
    const results = await sdk.getOpenPositions();
    printOpenPositions(results);

    expect(Array.isArray(results)).toBe(true);

    for (const { protocol, position } of results) {
      // Protocol must be a valid LendingProtocol value
      expect(Object.values(LendingProtocol)).toContain(protocol);

      // Position must have valid fields
      assertValidPosition(position);

      // Active position should have at least one supply or borrow
      expect(
        position.supplies.length > 0 || position.borrows.length > 0,
      ).toBe(true);
    }
  }, 60_000);

  it("does not return duplicate protocols", async () => {
    const results = await sdk.getOpenPositions();
    const protocols = results.map((r) => r.protocol);
    const unique = new Set(protocols);
    expect(unique.size).toBe(protocols.length);
  }, 60_000);

  it("consistent with individual getPosition calls", async () => {
    const openPositions = await sdk.getOpenPositions();

    for (const protocol of [
      LendingProtocol.Suilend,
      LendingProtocol.Navi,
      LendingProtocol.Scallop,
    ]) {
      const individual = await sdk.getPosition(protocol);
      const fromOpen = openPositions.find((r) => r.protocol === protocol);

      if (individual) {
        // If getPosition returns a position, getOpenPositions should include it
        expect(fromOpen).toBeDefined();
        expect(fromOpen!.position.collateral.symbol).toBe(
          individual.collateral.symbol,
        );
        expect(fromOpen!.position.debt.symbol).toBe(individual.debt.symbol);
      } else {
        // If getPosition returns null, getOpenPositions should not include it
        expect(fromOpen).toBeUndefined();
      }
    }
  }, 90_000);
});
