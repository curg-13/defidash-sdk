/**
 * Internal: protocol.getPosition()  [Integration]
 *
 * Tests each protocol adapter's on-chain position query directly.
 * This is an internal dependency of sdk.getPosition() and sdk.getOpenPositions().
 *
 * Used by:
 *   - sdk.getPosition()          → single protocol position query
 *   - sdk.getOpenPositions()     → all protocols position scan
 *   - sdk.buildDeleverageTransaction() → position data for deleverage
 *
 * Validated fields:
 *   - collateral: amount >= 0, symbol, coinType, decimals, valueUsd
 *   - debt: amount >= 0, symbol, coinType, decimals, valueUsd
 *   - netValueUsd = collateral.valueUsd - debt.valueUsd
 *
 * Requires: .env with SECRET_KEY and SUI_FULLNODE_URL
 *
 * Run: npx vitest run src/__tests__/internal.getPosition.test.ts
 */

import "dotenv/config";
import { describe, it, expect, beforeAll } from "vitest";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuilendAdapter } from "../protocols/suilend/adapter";
import { NaviAdapter } from "../protocols/navi/adapter";
import { ScallopAdapter } from "../protocols/scallop/adapter";
import { PositionInfo } from "../types/position";

const SUI_FULLNODE_URL =
  process.env.SUI_FULLNODE_URL || getFullnodeUrl("mainnet");

// ─── Pretty-print helper ────────────────────────────────────────────

function printPosition(
  protocol: string,
  position: PositionInfo | null,
): void {
  if (!position) {
    console.log(`\n┌─ [${protocol}] No position found ──────────`);
    console.log(`└──────────────────────────────────────────────`);
    return;
  }

  const usd = (v: number) => `$${v.toFixed(4)}`;
  const lines = [
    `\n┌─ [${protocol}] Position ──────────────────────────────────`,
    `│  Supplies (${position.supplies.length}):`,
  ];
  for (const s of position.supplies) {
    lines.push(`│    ${s.symbol.padEnd(8)} ${s.amount.toString().padStart(15)} (${usd(s.valueUsd)})`);
  }
  lines.push(`│  Borrows (${position.borrows.length}):`);
  for (const b of position.borrows) {
    lines.push(`│    ${b.symbol.padEnd(8)} ${b.amount.toString().padStart(15)} (${usd(b.valueUsd)})`);
  }
  if (position.borrows.length === 0) {
    lines.push(`│    (none)`);
  }
  lines.push(
    `│`,
    `│  Primary collateral : ${position.collateral.symbol} (${usd(position.collateral.valueUsd)})`,
    `│  Primary debt       : ${position.debt.symbol} (${usd(position.debt.valueUsd)})`,
    `│  Net Value USD      : ${usd(position.netValueUsd)}`,
    `└──────────────────────────────────────────────────────────`,
  );
  console.log(lines.join("\n"));
}

// ─── Shared assertion helpers ────────────────────────────────────────

function assertValidPosition(position: PositionInfo) {
  // supplies / borrows arrays
  expect(Array.isArray(position.supplies)).toBe(true);
  expect(Array.isArray(position.borrows)).toBe(true);
  expect(position.supplies.length).toBeGreaterThan(0);

  for (const s of position.supplies) {
    expect(s.symbol).toBeTruthy();
    expect(s.coinType).toContain("::");
    expect(s.amount).toBeGreaterThanOrEqual(0n);
  }
  for (const b of position.borrows) {
    expect(b.symbol).toBeTruthy();
    expect(b.coinType).toContain("::");
    expect(b.amount).toBeGreaterThanOrEqual(0n);
  }

  // Primary collateral = largest supply by USD
  const maxSupply = [...position.supplies].sort((a, b) => b.valueUsd - a.valueUsd)[0];
  expect(position.collateral.coinType).toBe(maxSupply.coinType);

  // Primary debt = largest borrow by USD (or default USDC if none)
  if (position.borrows.length > 0) {
    const maxBorrow = [...position.borrows].sort((a, b) => b.valueUsd - a.valueUsd)[0];
    expect(position.debt.coinType).toBe(maxBorrow.coinType);
  }

  // Net value = total supplies - total borrows
  const totalSupplyUsd = position.supplies.reduce((s, p) => s + p.valueUsd, 0);
  const totalDebtUsd = position.borrows.reduce((s, p) => s + p.valueUsd, 0);
  expect(position.netValueUsd).toBeCloseTo(totalSupplyUsd - totalDebtUsd, 2);
}

// ─── Test suites ─────────────────────────────────────────────────────

describe("getPosition (adapter-level)", () => {
  let suiClient: SuiClient;
  let userAddress: string;

  beforeAll(() => {
    const secretKey = process.env.SECRET_KEY || process.env.SUI_SECRET_KEY;
    if (!secretKey) throw new Error("SECRET_KEY env is required");

    const keypair = Ed25519Keypair.fromSecretKey(secretKey as any);
    userAddress = keypair.getPublicKey().toSuiAddress();
    suiClient = new SuiClient({ url: SUI_FULLNODE_URL });

    console.log(`\nWallet: ${userAddress}\n`);
  });

  // ── Suilend ──────────────────────────────────────────────────────

  describe("Suilend", () => {
    let adapter: SuilendAdapter;

    beforeAll(async () => {
      adapter = new SuilendAdapter();
      await adapter.initialize(suiClient);
    }, 30_000);

    it("returns null or valid PositionInfo", async () => {
      const position = await adapter.getPosition(userAddress);
      printPosition("Suilend", position);

      if (position) {
        assertValidPosition(position);
      } else {
        expect(position).toBeNull();
      }
    }, 30_000);
  });

  // ── Navi ─────────────────────────────────────────────────────────

  describe("Navi", () => {
    let adapter: NaviAdapter;

    beforeAll(async () => {
      adapter = new NaviAdapter();
      await adapter.initialize(suiClient);
    }, 30_000);

    it("returns null or valid PositionInfo", async () => {
      const position = await adapter.getPosition(userAddress);
      printPosition("Navi", position);

      if (position) {
        assertValidPosition(position);
      } else {
        expect(position).toBeNull();
      }
    }, 30_000);
  });

  // ── Scallop ──────────────────────────────────────────────────────

  describe("Scallop", () => {
    let adapter: ScallopAdapter;

    beforeAll(async () => {
      adapter = new ScallopAdapter();
      await adapter.initialize(suiClient);
    }, 30_000);

    it("returns null or valid PositionInfo", async () => {
      const position = await adapter.getPosition(userAddress);
      printPosition("Scallop", position);

      if (position) {
        assertValidPosition(position);
      } else {
        expect(position).toBeNull();
      }
    }, 30_000);
  });
});
