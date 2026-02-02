# Scallop: Collateral vs Lending Architecture

This document explains Scallop's dual-pool architecture and how it differs from traditional lending protocols.

## Overview

Unlike Aave or Compound where a single deposit serves both yield-earning and collateral purposes, Scallop separates these functions into two distinct pool types.

## Pool Types

| Pool Type | Purpose | Earns Interest | Enables Borrowing |
|-----------|---------|----------------|-------------------|
| **Lending Pool (Asset Pool)** | Supply assets to earn yield | Yes | No |
| **Collateral Pool** | Lock assets as borrowing collateral | No | Yes |

## Why This Design?

### 1. Risk Isolation

In traditional protocols:
```
Deposit 100 USDC → Earns yield + Becomes collateral → Liquidation risk on yield-earning assets
```

In Scallop:
```
Lending Pool deposit → Earns yield only (no liquidation risk)
Collateral Pool deposit → Enables borrowing (no yield)
```

### 2. Explicit User Intent

Users must explicitly choose:
- **Yield only**: Deposit to lending pool, receive sCoins, earn interest
- **Borrow only**: Add to collateral pool, borrow against it
- **Both**: Manage two separate positions

### 3. Capital Efficiency Control

You can optimize your strategy:
- Keep yield-earning assets safe from liquidation
- Use different assets for collateral vs yield farming

## Obligation System

Scallop tracks borrowing positions through an **Obligation** object:

```
Obligation = Collateral Deposits + Outstanding Debt
```

Each wallet can have up to 5 sub-accounts (Obligations), allowing multiple isolated positions.

## SDK Usage

### Earning Yield Only (No Borrowing)

```typescript
// Deposit to lending pool - earns interest, gets sCoins
const sCoin = await scallopTxBlock.depositQuick(amount, 'sui');

// Withdraw from lending pool
const coin = await scallopTxBlock.withdrawQuick(amount, 'sui');
```

### Borrowing (Requires Collateral)

```typescript
// Step 1: Create obligation (first time only)
await scallopTxBlock.openObligationEntry();

// Step 2: Add collateral (does NOT earn interest)
await scallopTxBlock.addCollateralQuick(amount, 'sui', obligationId);

// Step 3: Borrow against collateral
const borrowedCoin = await scallopTxBlock.borrowQuick(amount, 'usdc', obligationId);

// Repay debt
await scallopTxBlock.repayQuick(amount, 'usdc', obligationId);

// Remove collateral (after repaying debt)
const collateral = await scallopTxBlock.takeCollateralQuick(amount, 'sui', obligationId);
```

## Common Mistakes

### Wrong: Trying to borrow after deposit

```typescript
// This will NOT enable borrowing
await scallopTxBlock.depositQuick(100, 'sui');
await scallopTxBlock.borrowQuick(50, 'usdc');  // Error: No collateral
```

### Correct: Add collateral before borrowing

```typescript
// Must add to collateral pool, not lending pool
await scallopTxBlock.addCollateralQuick(100, 'sui', obligationId);
await scallopTxBlock.borrowQuick(50, 'usdc', obligationId);  // Works
```

## Collateral Weight

Each asset has a **Collateral Weight** (typically < 1.0) determining borrowing capacity:

```
Borrowing Capacity = Collateral Amount × Asset Price × Collateral Weight
```

Example:
- Deposit 1 SUI valued at $1.00
- Collateral Weight: 70%
- Borrowing Capacity: $0.70 worth of assets

## Borrow Weight

Volatile assets may have a **Borrow Weight** > 1.0, increasing effective debt:

| Asset Type | Typical Borrow Weight |
|------------|----------------------|
| Stablecoins (USDC) | 1.0 |
| Volatile (SUI) | 1.25 |

This makes borrowing volatile assets relatively more expensive.

## Comparison with Other Protocols

| Feature | Aave/Compound | Scallop |
|---------|---------------|---------|
| Single deposit for yield + collateral | Yes | No |
| Separate collateral management | No | Yes |
| Yield on collateral | Yes | No |
| Risk isolation | Limited | Full |
| Complexity | Lower | Higher |

## References

- [Scallop Lending Docs](https://docs.scallop.io/scallop-lend/lending)
- [Scallop Borrowing Docs](https://docs.scallop.io/scallop-lend/borrowing)
- [Scallop SDK Builder](https://github.com/scallop-io/sui-scallop-sdk/blob/main/document/builder.md)
