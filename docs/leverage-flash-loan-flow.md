# Leverage Position Opening with Flash Loans

> How the DefiDash SDK opens leveraged lending positions atomically using flash loans on Sui

---

## Overview

A **leverage position** amplifies exposure to an asset using borrowed funds. For example, with 2x leverage on SUI, you deposit $100 of SUI but gain $200 of SUI exposure — the extra $100 comes from borrowing.

The challenge: **you need the extra funds _before_ you have collateral to borrow against.** Flash loans solve this chicken-and-egg problem.

---

## What is a Flash Loan?

A flash loan is an **uncollateralized loan that must be repaid within the same transaction**. On Sui, this means the borrow and repay happen in a single Programmable Transaction Block (PTB). If the repayment doesn't happen, the entire transaction reverts — no funds are lost.

Key properties:
- **No collateral required** — the atomicity guarantee replaces collateral
- **Must repay in same PTB** — the Sui runtime enforces this via a receipt object
- **Small fee** — Scallop charges a fee rate per flash loan (queried on-chain)
- **USDC denominated** — our strategy always flash-borrows USDC

---

## The Leverage Loop

### Step-by-step Flow

```
User has: $100 worth of SUI
Target: 2x leverage (2× SUI exposure)

┌─────────────────────────────────────────────────────────────┐
│                 Single Atomic PTB                           │
│                                                             │
│  1. Flash Loan     ───→  Borrow $100 USDC from Scallop     │
│                          (no collateral needed)             │
│                                                             │
│  2. Swap           ───→  $100 USDC → ~$99.50 SUI           │
│                          (via 7k Protocol aggregator)       │
│                                                             │
│  3. Merge & Deposit ──→  $100 SUI (user) + $99.50 SUI      │
│                          = $199.50 SUI into lending pool    │
│                                                             │
│  4. Refresh Oracles ──→  Update price feeds                 │
│                          (required before borrow)           │
│                                                             │
│  5. Borrow USDC    ───→  Borrow ~$100.50 USDC              │
│                          against $199.50 SUI collateral     │
│                          (includes fee buffer)              │
│                                                             │
│  6. Repay Flash Loan ─→  Return $100 USDC + fee            │
│                          to Scallop flash loan pool         │
│                                                             │
│  Result: User has $199.50 SUI collateral,                   │
│          $100.50 USDC debt — ~2x leveraged SUI position     │
└─────────────────────────────────────────────────────────────┘
```

### Why This Works

The key insight is that **all 6 steps execute atomically**. The lending protocol sees the collateral deposit (step 3) before the borrow (step 5), even though the collateral was partially funded by the flash loan. If any step fails, the entire transaction reverts cleanly.

---

## Detailed Calculation

### Flash Loan Amount

```
flashLoanUsd = initialEquityUsd × (multiplier - 1)
flashLoanUsdc = ceil(flashLoanUsd × 1e6)   // USDC has 6 decimals
```

For $100 at 2x: `flashLoanUsdc = $100 × 1 × 1e6 = 100,000,000` (100 USDC)

### Collateral After Swap

The swapped amount is slightly less than the flash loan due to **swap slippage** (DEX price impact + routing inefficiency):

```
swappedAmount ≈ flashLoanUsd × (1 - slippage)
totalCollateral = userDeposit + swappedAmount
```

For 0.5% slippage: `totalCollateral ≈ $100 + $99.50 = $199.50`

### Borrow to Repay

The protocol borrow must cover:
1. **Flash loan principal** — the exact amount borrowed
2. **Flash loan fee** — queried from Scallop's on-chain fee table
3. **Borrow fee buffer** — small buffer (0.3-0.5%) for interest that accrues immediately

```
repaymentAmount = flashLoanUsdc + flashLoanFee
borrowAmount = ceil(repaymentAmount × borrowFeeBuffer)
```

### Borrow Capacity Check

The borrow succeeds only if the lending protocol allows it:

```
totalCollateral_USD × LTV ≥ borrowAmount
```

For our example (Suilend, LTV=70%):
- Borrow capacity = $199.50 × 0.70 = **$139.65**
- Need to borrow = $100 × 1.005 = **$100.50**
- $139.65 > $100.50 → Borrow succeeds

### Safety at High Multipliers

The theoretical max multiplier is `1 / (1 - LTV)`. At LTV = 70%, max = 3.33x.

In practice, swap slippage reduces effective collateral, so the safe max is slightly below the theoretical limit. If the borrow fails (insufficient collateral), the entire PTB reverts — no funds are lost.

| Multiplier | Flash Loan | Collateral (1% slip) | Borrow Capacity (70% LTV) | Need to Borrow | Status |
|-----------|-----------|---------------------|--------------------------|---------------|--------|
| 2.0x | $100 | $199.00 | $139.30 | $100.50 | Safe |
| 3.0x | $200 | $298.00 | $208.60 | $201.00 | Safe |
| 3.2x | $220 | $317.80 | $222.46 | $221.10 | Tight |
| 3.33x | $233 | $330.67 | $231.47 | $234.17 | Reverts |

---

## Two Execution Paths

### 1. Generic Path (`buildLeverageTransaction`)

Used by Suilend and Navi adapters. Located in [src/strategies/leverage.ts](../src/strategies/leverage.ts).

- Uses plain Sui `Transaction` object
- Flash loan via `ScallopFlashLoanClient` (direct Move calls)
- Protocol operations via `ILendingProtocol` adapter interface
- Borrow fee buffer: **0.5%** (`BORROW_FEE_BUFFER = 1.005`)

### 2. Scallop-specific Path (`executeScallopLeverage`)

Located in [src/sdk.ts](../src/sdk.ts). Uses Scallop's own SDK for tighter integration.

- Uses Scallop's `ScallopBuilder` transaction block
- Flash loan via Scallop SDK's built-in `borrowFlashLoan`
- Handles obligation management (create, unstake, add collateral, restake)
- Flash loan fee queried on-chain via `ScallopFlashLoanClient.calculateFee()`
- Borrow fee buffer: **0.3%** (`borrowFeeBuffer = 1.003`)

---

## Protocol-Specific Details

### Scallop Obligations

Scallop uses **obligation objects** to track positions. When opening a leverage position:

1. **Existing obligation** — unstake if locked, then add collateral
2. **New obligation** — create obligation, add collateral, return hot potato, stake, transfer key

The obligation must be staked after operations to continue earning staking rewards.

### Oracle Refresh

All lending protocols require fresh oracle prices before borrow operations:

```typescript
// Generic path
await protocol.refreshOracles(tx, [depositCoinType, USDC_COIN_TYPE], userAddress);

// Scallop path
await tx.updateAssetPricesQuick([coinName, "usdc"]);
```

Skipping oracle refresh will cause borrow to fail with stale price errors.

### SUI Coin Handling

SUI is special on Sui — it's the gas token. The user's deposit comes from splitting the gas coin:

```typescript
// SUI: split from gas coin
const [userDeposit] = tx.splitCoins(tx.gas, [tx.pure.u64(depositAmount)]);
tx.mergeCoins(swappedAsset, [userDeposit]);

// Non-SUI: fetch coin objects, merge, split
const userCoins = await suiClient.getCoins({ owner, coinType });
const [userContribution] = tx.splitCoins(primaryCoin, [depositAmount]);
tx.mergeCoins(swappedAsset, [userContribution]);
```

---

## Risk Parameters

Each protocol defines risk parameters per asset that constrain the leverage:

| Parameter | Description | Impact |
|-----------|-------------|--------|
| **LTV** (Loan-to-Value) | Max borrow ratio against collateral | Determines max multiplier |
| **Liquidation Threshold** | Debt/collateral ratio triggering liquidation | Higher = more buffer before liquidation |
| **Max Multiplier** | `1 / (1 - LTV)` | Hard cap on leverage |

Example values (SUI):

| Protocol | LTV | Liq. Threshold | Max Multiplier |
|----------|-----|---------------|----------------|
| Suilend | 70% | 75% | 3.33x |
| Navi | 75% | 70% | 4.00x |
| Scallop | 85% | 90% | 6.67x |

---

## Safety Guarantees

1. **Atomic execution** — If any step fails, the entire transaction reverts. No partial states.
2. **Flash loan receipt** — Sui's type system enforces repayment. The receipt object can only be consumed by `repayFlashLoan`.
3. **Slippage protection** — Swap operations include minimum amount out (1% tolerance via 7k aggregator).
4. **Borrow fee buffer** — Extra 0.3-0.5% borrowed to cover immediate interest accrual.
5. **Unsupported asset rejection** — Stablecoins (USDC, wUSDC) are rejected upfront since borrowing USDC against USDC collateral creates circular risk.

---

## Related Documentation

- [Preview Leverage](sdk-methods/preview-leverage.md) — How `previewLeverage` calculates expected position metrics
- [Protocol Risk Params](protocol-risk-params-research.md) — How LTV and liquidation thresholds are fetched per protocol
- [Protocol APY Research](protocol-apy-research.md) — Supply/borrow APY data sources
- [Scallop Collateral vs Lending](scallop-collateral-vs-lending.md) — Scallop's obligation and collateral model
- [Gas Cost Analysis](gas-cost-analysis-suilend-vs-scallop.md) — Transaction gas costs across protocols
