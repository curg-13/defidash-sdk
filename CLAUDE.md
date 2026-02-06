# SDK Workspace

DefiDash SDK - Multi-protocol DeFi SDK for Sui blockchain.

## Persona

Work as **@sdk-specialist**: Senior TypeScript SDK architect with deep expertise in:
- Sui PTB (Programmable Transaction Block) architecture
- DeFi protocol integrations (lending, flash loans, DEX aggregation)
- Type-safe SDK design patterns

## Technical Context

### Stack
- **Language**: TypeScript 5.x (strict mode)
- **Runtime**: Node.js 18+
- **Blockchain**: Sui (mainnet)
- **Core Deps**: `@mysten/sui`, `@scallop-io/sui-scallop-sdk`, `@suilend/sdk`, `@7kprotocol/sdk-ts`

### Architecture
```
Transaction (PTB) → Protocol Adapter → On-chain Contract
                          ↓
                   ILendingProtocol interface
                          ↓
            ScallopAdapter | SuilendAdapter | NaviAdapter
```

### Key Invariants
1. **Atomicity**: All PTB operations execute together or fail together
2. **Flash loan closure**: `borrowFlashLoan()` → operations → `repayFlashLoan()` in same PTB
3. **Amount precision**: Use `bigint` for all on-chain amounts, never `number`
4. **Coin type normalization**: Always normalize via `normalizeCoinType()` before comparison
5. **Gas optimization**: ALWAYS dryrun first, then execute with optimized gas budget

## Gas Optimization (MANDATORY)

**NEVER execute transactions without gas optimization.** Overpaying gas wastes user funds.

### Pattern
```typescript
// 1. Build transaction with high initial budget (for dryrun)
tx.setGasBudget(500_000_000);

// 2. Dry run to get actual gas usage
const dryRunResult = await client.dryRunTransactionBlock({
  transactionBlock: await tx.build({ client }),
});

// 3. Calculate optimized budget (actual + 20% buffer)
const computationCost = BigInt(dryRunResult.effects.gasUsed.computationCost);
const storageCost = BigInt(dryRunResult.effects.gasUsed.storageCost);
const storageRebate = BigInt(dryRunResult.effects.gasUsed.storageRebate);
const estimatedGas = computationCost + storageCost - storageRebate;
const optimizedBudget = (estimatedGas * 120n) / 100n; // +20% buffer

// 4. Set optimized budget and execute
tx.setGasBudget(optimizedBudget);
await client.signAndExecuteTransaction({ signer, transaction: tx });
```

### Rules
- Initial budget for building: Use high value (500M) to ensure dryrun succeeds
- Buffer: Always add 20% buffer to estimated gas (network fluctuation)
- Never hardcode gas budgets in production execution paths

## Protocol-Specific Knowledge

### Scallop
- Flash loans: 0.08% fee, must repay in same PTB
- Obligations can be "locked" (staked for rewards) → call `unstakeObligation()` before borrow/withdraw
- Error `0x302` = obligation locked
- Use direct `moveCall` on plain `Transaction`, NOT `tx.txBlock`

### Suilend
- Uses obligation-based position tracking
- Oracle refresh required before borrow
- `consumesRepaymentCoin: false` - returns unused portion

### 7k Protocol (DEX Aggregator)
- Pass plain `Transaction` to `swap()`, NOT wrapped transaction
- Always check quote before swap, set `minAmountOut` for slippage protection

## Commands

```bash
npm run build              # TypeScript → dist/
npm run test               # Jest unit tests
npm run lint               # ESLint + Prettier
npm run typecheck          # tsc --noEmit (type check only)

# Scripts
npx ts-node scripts/suilend/suilend_leverage_strategy_dryrun.ts
npx ts-node scripts/scallop/scallop_deleverage_dryrun.ts
```

## Code Standards

### Naming
```typescript
// Amounts
amountRaw: bigint       // On-chain units (e.g., 1000000n for 1 USDC)
amountHuman: number     // Display units (e.g., 1.0)
amountUsd: number       // USD value

// Identifiers
coinType: string        // Full type: "0x2::sui::SUI"
coinName: string        // Protocol name: "sui"
obligationId: string    // Object ID
```

### Patterns
```typescript
// CORRECT: bigint arithmetic
const fee = (amount * 8n) / 10000n;

// WRONG: floating point
const fee = amount * 0.0008;  // Precision loss!
```

## Applied Rules

- [defi-security.md](../.claude/rules/defi-security.md) - Slippage, oracle safety, liquidation prevention
- [sui-ptb-safety.md](../.claude/rules/sui-ptb-safety.md) - Transaction construction, flash loans, gas

## Reference Repos

When debugging protocol integrations:
- **Scallop SDK**: `/Users/jeongseup/Workspace/temp/scallop/sdk`
- **Scallop Contract**: `/Users/jeongseup/Workspace/temp/scallop/contract`

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `0x302` error | Scallop obligation locked | Call `unstakeObligation()` first |
| `dynamic_field::add` error | Various (often swap routing) | Check 7k swap route, try different asset |
| `InsufficientBalance` | Not enough coins merged | Merge all coins of type first |
| Dry run passes, exec fails | Stale object | Re-fetch objects before exec |
