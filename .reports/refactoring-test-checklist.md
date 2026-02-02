# Refactoring Test Checklist

**Branch**: `refactor/split-scallop-adapter`
**Date**: 2026-02-02
**Commits**: 6 commits

---

## ✅ Completed Refactoring Tasks

1. Directory reorganization (lib/ → protocols/)
2. Scallop types extraction (types.ts)
3. Coin/amount utilities consolidation
4. SDK.ts cleanup (removed 'as any' casts)
5. Gas optimization utilities extraction
6. Error handling standardization

---

## 📋 Test Checklist

### 1. Build & Type Checking

```bash
# Should pass without errors
npm run build

# Type check only
npm run typecheck

# Lint check
npm run lint
```

**Expected**: ✅ All pass without errors

---

### 2. Example Scripts Testing

#### 2.1 Portfolio Query (Read-only, safest to test first)

```bash
npm run example:portfolio
```

**Test Cases**:
- [ ] Successfully connects to Sui client
- [ ] SDK initializes without errors
- [ ] Fetches portfolio data from all protocols (Suilend, Scallop, Navi)
- [ ] Displays balances and positions correctly
- [ ] No runtime errors

**Required .env vars**:
```bash
SECRET_KEY=<your_secret_key>
```

---

#### 2.2 Leverage Strategy (Dry Run)

```bash
# Edit .env first to set:
# LEVERAGE_PROTOCOL=scallop
# LEVERAGE_DEPOSIT_COIN_TYPE=SUI
# LEVERAGE_DEPOSIT_VALUE_USD=1.0
# LEVERAGE_MULTIPLIER=2

npm run example:leverage
```

**Test Cases**:
- [ ] SDK initializes
- [ ] Resolves coin type correctly (SUI symbol → full type)
- [ ] Calculates leverage preview
- [ ] Shows flash loan amount and expected position
- [ ] Dry run succeeds with gas estimation
- [ ] **Does NOT execute transaction** (dryRun should be true)

**Required .env vars**:
```bash
SECRET_KEY=<your_secret_key>
LEVERAGE_PROTOCOL=scallop
LEVERAGE_DEPOSIT_COIN_TYPE=SUI
LEVERAGE_DEPOSIT_VALUE_USD=1.0
LEVERAGE_MULTIPLIER=2
```

**Expected Output**:
```
📦 Initializing DefiDash SDK...
   ✅ SDK initialized

📈 Leverage Preview:
───────────────────────────────────────────────────────
   Protocol:       scallop
   Deposit Asset:  SUI
   Deposit Amount: 1.0
   Multiplier:     2x
───────────────────────────────────────────────────────
   Initial Equity:    $1.00
   Flash Loan:        1.00 USDC
   Total Position:    $2.00
   Total Debt:        $1.00
   Position LTV:      50.0%
   ...
───────────────────────────────────────────────────────

🔧 Executing leverage strategy (DRY RUN)...
   ✅ Dry run successful!
   ⛽ Gas: 0.XXXXXX SUI
```

---

#### 2.3 Deleverage Strategy (Dry Run)

```bash
# Edit .env first to set:
# LEVERAGE_PROTOCOL=scallop (or the protocol where you have a position)

npm run example:deleverage
```

**Test Cases**:
- [ ] SDK initializes
- [ ] Fetches current position
- [ ] Calculates deleverage strategy
- [ ] Shows swap amounts and expected results
- [ ] Dry run succeeds
- [ ] **Does NOT execute transaction**

**Required .env vars**:
```bash
SECRET_KEY=<your_secret_key>
LEVERAGE_PROTOCOL=scallop
```

**Prerequisites**: You must have an active leveraged position on the specified protocol

---

### 3. Protocol-Specific Tests

#### 3.1 Scallop

**Test unlocked/locked obligation handling**:
```bash
# In scripts/scallop/
npx ts-node scripts/scallop/scallop_leverage_exec.ts
```

- [ ] Detects locked obligations
- [ ] Calls `unstakeObligation()` if needed
- [ ] `clearPendingState()` works correctly
- [ ] Flash loan integration works

#### 3.2 Suilend

```bash
npx ts-node scripts/suilend/suilend_leverage_strategy_dryrun.ts
```

- [ ] Oracle refresh works
- [ ] Reserve lookup by coin type works
- [ ] Borrow/repay operations work
- [ ] consumesRepaymentCoin: false behavior

#### 3.3 Navi

- [ ] Protocol adapter initializes
- [ ] Basic operations work

---

### 4. Utility Functions Tests

#### 4.1 Gas Optimization

Create test file: `test/gas-optimization.test.ts`

```typescript
import {
  calculateActualGas,
  calculateOptimizedBudget,
  DRYRUN_GAS_BUDGET
} from '../src/utils/gas';

// Test 1: calculateActualGas
const gasUsed = {
  computationCost: "1000000",
  storageCost: "500000",
  storageRebate: "200000"
};
const actual = calculateActualGas(gasUsed);
// Expected: 1000000 + 500000 - 200000 = 1300000n

// Test 2: calculateOptimizedBudget
const optimized = calculateOptimizedBudget(1000000n);
// Expected: 1000000n * 120 / 100 = 1200000n
```

**Manual verification**:
- [ ] Gas calculations are correct
- [ ] 20% buffer applied correctly
- [ ] DRYRUN_GAS_BUDGET = 100_000_000 (0.1 SUI)

#### 4.2 Coin/Amount Utilities

```typescript
import {
  parseUnits,
  formatUnits,
  toRawUnits,
  fromRawUnits
} from '../src/utils';

// Test parseUnits
parseUnits("1.5", 6); // Expected: 1500000n

// Test formatUnits
formatUnits(1500000n, 6); // Expected: "1.5"

// Test toRawUnits (wrapper)
toRawUnits(1.5, 6); // Expected: 1500000n
toRawUnits("1.5", 6); // Expected: 1500000n

// Test fromRawUnits
fromRawUnits(1500000n, 6); // Expected: 1.5
```

**Manual verification**:
- [ ] parseUnits handles decimals correctly
- [ ] formatUnits removes trailing zeros
- [ ] toRawUnits accepts both number and string
- [ ] fromRawUnits returns number

#### 4.3 Error Classes

```typescript
import {
  SDKNotInitializedError,
  UnknownAssetError,
  InvalidParameterError
} from '../src/utils/errors';

// Test error instances
try {
  throw new SDKNotInitializedError();
} catch (e) {
  console.log(e instanceof SDKNotInitializedError); // true
  console.log(e.name); // "SDKNotInitializedError"
  console.log(e.message); // "SDK not initialized. Call initialize() first."
}
```

**Manual verification**:
- [ ] Custom errors can be caught by type
- [ ] Error messages are descriptive
- [ ] Error names match class names

---

### 5. Edge Cases & Error Handling

#### 5.1 Invalid Input

```typescript
// Test 1: Unknown asset
sdk.resolveCoinType("INVALID_SYMBOL");
// Expected: UnknownAssetError

// Test 2: Both amount and USD provided
sdk.leverage({
  protocol: LendingProtocol.Scallop,
  depositAsset: 'SUI',
  depositAmount: '1.0',
  depositValueUsd: 1.0, // Should error
  multiplier: 2
});
// Expected: InvalidParameterError

// Test 3: Neither amount nor USD provided
sdk.leverage({
  protocol: LendingProtocol.Scallop,
  depositAsset: 'SUI',
  // missing both depositAmount and depositValueUsd
  multiplier: 2
});
// Expected: InvalidParameterError
```

#### 5.2 SDK Not Initialized

```typescript
const sdk = new DefiDashSDK();
// Don't call initialize()
sdk.leverage({ ... });
// Expected: SDKNotInitializedError
```

#### 5.3 No Position / No Debt

```typescript
// Try to deleverage when no position exists
sdk.deleverage({ protocol: LendingProtocol.Scallop });
// Expected: PositionNotFoundError

// Try to deleverage when debt = 0
// Expected: NoDebtError
```

---

### 6. Integration Test Scenarios

#### 6.1 Full Leverage Flow (Real Execution - Use Small Amounts!)

⚠️ **WARNING**: This will execute real transactions. Use testnet or minimal amounts!

```bash
# Set in .env:
# LEVERAGE_DEPOSIT_VALUE_USD=0.1  # Small amount!
# LEVERAGE_MULTIPLIER=1.5  # Conservative multiplier

# Edit example/leverage.ts to set dryRun: false
npm run example:leverage
```

**Verify**:
- [ ] Transaction succeeds
- [ ] Gas is optimized (not overpaying)
- [ ] Position is created correctly
- [ ] Flash loan is repaid
- [ ] All coins are merged/split correctly

#### 6.2 Full Deleverage Flow (Real Execution)

⚠️ **WARNING**: Real transaction! Will close your position!

```bash
# Edit example/deleverage.ts to set dryRun: false
npm run example:deleverage
```

**Verify**:
- [ ] Transaction succeeds
- [ ] Debt is fully repaid
- [ ] Remaining collateral withdrawn
- [ ] Position closed correctly

---

## 🔍 Regression Testing

Test that existing functionality still works:

### Before Refactoring (dev branch)
```bash
git checkout dev
npm run build
npm run example:portfolio
# Record outputs
```

### After Refactoring (refactor branch)
```bash
git checkout refactor/split-scallop-adapter
npm run build
npm run example:portfolio
# Compare outputs - should be identical
```

**Verify**:
- [ ] Portfolio values match
- [ ] Position data matches
- [ ] Gas costs similar (within 5%)
- [ ] No new errors

---

## 📊 Performance Checks

```bash
# Build size
du -sh dist/

# Bundle analysis (if applicable)
npm run analyze

# Memory usage during examples
/usr/bin/time -l npm run example:portfolio
```

**Baseline** (before refactoring):
- dist/ size: ~XXX KB
- Memory usage: ~XXX MB

**After refactoring**:
- [ ] dist/ size similar or smaller
- [ ] Memory usage similar or lower
- [ ] No significant performance regression

---

## ✅ Sign-off Checklist

Before merging to dev:

- [ ] All build commands pass
- [ ] All 3 examples run successfully
- [ ] Error handling works as expected
- [ ] No TypeScript errors
- [ ] No ESLint warnings
- [ ] Gas optimization works correctly
- [ ] Regression tests pass
- [ ] Performance acceptable

---

## 🐛 Known Issues / Limitations

*(Add any issues found during testing)*

- [ ] None identified yet

---

## 📝 Notes for Next Steps

After this refactoring is stable, consider:

1. **Add JSDoc to public APIs** - Improve developer experience
2. **Create BaseProtocolAdapter** - Reduce code duplication
3. **Simplify strategy builders** - Make them more maintainable
4. **Remove remaining 'as any' casts** - 26 in adapters/strategies
5. **Add unit tests** - Use Jest or Vitest
6. **Add E2E tests** - Automated testing of full flows

---

**Test Execution Date**: ___________
**Tester**: ___________
**Result**: ⬜ PASS / ⬜ FAIL
**Notes**: _____________________________________
