/**
 * Unit Tests: calculateDeleverageEstimate
 *
 * Tests the deleverage estimate calculation with mocked swap quotes.
 * No mainnet RPC required.
 *
 * Run: npx vitest run src/__tests__/deleverageEstimate.unit.test.ts
 */

import { describe, it, expect, vi } from "vitest";
import { calculateDeleverageEstimate } from "../strategies/deleverage";
import type { DeleverageBuildParams } from "../strategies/deleverage";
import { COIN_TYPES } from "../types";

// Mock external dependencies
vi.mock("@7kprotocol/sdk-ts", () => ({
  MetaAg: vi.fn(),
  getTokenPrice: vi.fn().mockResolvedValue(3.5), // SUI at $3.50
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockParams(
  overrides: Partial<{
    debtAmount: bigint;
    collateralAmount: bigint;
    swapAmountOut: string;
  }> = {},
): DeleverageBuildParams {
  const debtAmount = overrides.debtAmount ?? 100_000_000n; // 100 USDC
  const collateralAmount = overrides.collateralAmount ?? 100_000_000_000n; // 100 SUI
  const swapAmountOut = overrides.swapAmountOut ?? "120000000"; // 120 USDC out for full collateral

  const mockSwapClient = {
    quote: vi.fn().mockResolvedValue([
      {
        amountOut: swapAmountOut,
        amountIn: collateralAmount.toString(),
        route: [],
      },
    ]),
  };

  const mockProtocol = {
    name: "suilend",
    consumesRepaymentCoin: false,
  };

  return {
    protocol: mockProtocol as any,
    flashLoanClient: {} as any,
    swapClient: mockSwapClient as any,
    suiClient: {} as any,
    userAddress: "0xtest",
    position: {
      collateral: {
        coinType: COIN_TYPES.SUI,
        symbol: "SUI",
        decimals: 9,
        amount: collateralAmount,
        valueUsd: 350,
      },
      debt: {
        coinType: COIN_TYPES.USDC,
        symbol: "USDC",
        decimals: 6,
        amount: debtAmount,
        valueUsd: 100,
      },
      healthFactor: 2.0,
      netValueUsd: 250,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("calculateDeleverageEstimate (unit)", () => {
  it("calculates flash loan with small buffer", async () => {
    const params = createMockParams();
    const estimate = await calculateDeleverageEstimate(params);

    // Flash loan = debt * 1001/1000 (0.1% buffer)
    const expectedFlashLoan = (100_000_000n * 1001n) / 1000n;
    expect(estimate.flashLoanUsdc).toBe(expectedFlashLoan);
  });

  it("calculates flash loan fee", async () => {
    const params = createMockParams();
    const estimate = await calculateDeleverageEstimate(params);

    // Fee should be non-negative
    expect(estimate.flashLoanFee).toBeGreaterThanOrEqual(0n);

    // Total repayment = flash loan + fee
    expect(estimate.totalRepayment).toBe(
      estimate.flashLoanUsdc + estimate.flashLoanFee,
    );
  });

  it("calculates swap amount to cover repayment", async () => {
    const params = createMockParams();
    const estimate = await calculateDeleverageEstimate(params);

    // swapAmount should be positive and <= total collateral
    expect(estimate.swapAmount).toBeGreaterThan(0n);
    expect(estimate.swapAmount).toBeLessThanOrEqual(100_000_000_000n);
  });

  it("calculates keepCollateral correctly", async () => {
    const params = createMockParams();
    const estimate = await calculateDeleverageEstimate(params);

    // keepCollateral = withdrawAmount - swapAmount
    expect(estimate.keepCollateral).toBe(
      100_000_000_000n - estimate.swapAmount,
    );
  });

  it("total profit includes kept collateral and USDC surplus", async () => {
    const params = createMockParams();
    const estimate = await calculateDeleverageEstimate(params);

    // Total profit should be positive when collateral value > debt
    expect(estimate.totalProfitUsd).toBeGreaterThan(0);
  });

  it("caps swap amount at full collateral when needed", async () => {
    // Scenario: swap rate is bad, need all collateral
    const params = createMockParams({
      debtAmount: 500_000_000n, // 500 USDC debt
      collateralAmount: 100_000_000_000n, // 100 SUI
      swapAmountOut: "200000000", // Only get 200 USDC for full collateral
    });

    const estimate = await calculateDeleverageEstimate(params);

    // swapAmount should not exceed collateral
    expect(estimate.swapAmount).toBeLessThanOrEqual(100_000_000_000n);
  });

  it("throws when no swap quotes available", async () => {
    const params = createMockParams();
    (params.swapClient.quote as any).mockResolvedValue([]);

    await expect(
      calculateDeleverageEstimate(params),
    ).rejects.toThrow("No swap quotes found");
  });
});
