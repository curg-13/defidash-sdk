/**
 * Unit tests for normalizeCoinType utility function
 *
 * Migrated from scripts/tests/test_normalize_coin_type.ts
 */

import { describe, it, expect } from "vitest";
import { normalizeCoinType } from "../utils/coin";
import { InvalidCoinTypeError } from "../utils/errors";
import { COIN_TYPES } from "../types/constants";

describe("normalizeCoinType", () => {
  it("pads short SUI address to 64 chars", () => {
    expect(normalizeCoinType("0x2::sui::SUI")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI",
    );
  });

  it("keeps full SUI address unchanged", () => {
    expect(normalizeCoinType(COIN_TYPES.SUI)).toBe(COIN_TYPES.SUI);
  });

  it("keeps full LBTC address unchanged", () => {
    expect(normalizeCoinType(COIN_TYPES.LBTC)).toBe(COIN_TYPES.LBTC);
  });

  it("keeps already-normalized LBTC unchanged", () => {
    const normalized =
      "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC";
    expect(normalizeCoinType(normalized)).toBe(normalized);
  });

  it("keeps full XBTC address unchanged", () => {
    expect(normalizeCoinType(COIN_TYPES.XBTC)).toBe(COIN_TYPES.XBTC);
  });

  it("keeps full USDC address unchanged", () => {
    expect(normalizeCoinType(COIN_TYPES.USDC)).toBe(COIN_TYPES.USDC);
  });

  it("keeps full ETH address unchanged", () => {
    expect(normalizeCoinType(COIN_TYPES.ETH)).toBe(COIN_TYPES.ETH);
  });

  it("throws InvalidCoinTypeError on invalid format", () => {
    expect(() => normalizeCoinType("invalid")).toThrow(InvalidCoinTypeError);
  });

  it("pads short hex address", () => {
    expect(normalizeCoinType("0xabc::module::Type")).toBe(
      "0x0000000000000000000000000000000000000000000000000000000000000abc::module::Type",
    );
  });
});
