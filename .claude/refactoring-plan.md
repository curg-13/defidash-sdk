# SDK Refactoring Plan

**Goal**: Clean up SDK code to support 3 core examples (`leverage`, `deleverage`, `get_portfolio`)

**Timeline**: 2.5-3 days

---

## 🎯 Current Issues

1. **Directory Structure** - `lib/` mixes common utilities with protocol-specific code
2. **Large Files** - `protocols/scallop.ts` is 1075 lines (too large)
3. **Code Duplication** - Coin/amount utilities scattered across files
4. **Type Safety** - 13+ `as any` casts, missing JSDoc
5. **Logging** - 48 `console.log` statements (should use logger)
6. **Error Handling** - Inconsistent error messages across protocols

---

## 📁 Proposed Directory Structure

```
src/
├── index.ts                    # Public API exports
├── sdk.ts                      # DefiDashSDK class (clean)
│
├── protocols/                  # Protocol adapters
│   ├── base.ts                # BaseProtocolAdapter (common logic)
│   │
│   ├── suilend/
│   │   ├── adapter.ts         # SuilendAdapter
│   │   ├── types.ts           # Suilend-specific types
│   │   ├── calculators.ts     # Health factor, APY calculations
│   │   └── constants.ts       # Reserve definitions
│   │
│   ├── scallop/
│   │   ├── adapter.ts         # ScallopAdapter (~300 lines)
│   │   ├── obligation.ts      # Obligation management (~200 lines)
│   │   ├── operations.ts      # Deposit/borrow/repay (~200 lines)
│   │   ├── flash-loan.ts      # Flash loan client (~200 lines)
│   │   ├── types.ts           # Scallop-specific types
│   │   └── constants.ts       # Address configs
│   │
│   └── navi/
│       ├── adapter.ts         # NaviAdapter
│       ├── types.ts
│       └── constants.ts
│
├── strategies/                 # Core strategies
│   ├── leverage.ts            # buildLeverageTransaction
│   ├── deleverage.ts          # buildDeleverageTransaction
│   └── index.ts
│
├── types/                      # Shared types
│   ├── index.ts               # Re-exports
│   ├── common.ts              # LendingProtocol enum
│   ├── position.ts            # PositionInfo, AccountPortfolio
│   ├── protocol.ts            # ILendingProtocol interface
│   ├── strategy.ts            # LeverageParams, DeleverageParams
│   ├── config.ts              # SDKOptions
│   └── constants.ts           # Coin types, defaults
│
└── utils/                      # Utilities
    ├── coin.ts                # normalizeCoinType, parseUnits, formatUnits
    ├── format.ts              # Display helpers
    ├── gas.ts                 # Gas optimization (NEW)
    ├── logger.ts              # Logging utilities
    └── index.ts
```

### Changes from Current Structure

**Move**:
- `lib/scallop/flash-loan-client.ts` → `protocols/scallop/flash-loan.ts`
- `lib/suilend/calculators.ts` → `protocols/suilend/calculators.ts`
- `lib/suilend/const.ts` → `protocols/suilend/constants.ts`
- `lib/suilend/suilend.ts` → `protocols/suilend/types.ts`

**Split**:
- `protocols/scallop.ts` (1075 lines) → 4 files:
  - `adapter.ts` (300 lines) - Main adapter class
  - `obligation.ts` (200 lines) - Obligation management
  - `operations.ts` (200 lines) - Protocol operations
  - `flash-loan.ts` (200 lines) - Flash loan client

**Delete**:
- `lib/` directory (after moving all files)

---

## 📋 Phase 1: Directory Restructure (Day 1)

### Task 1.1: Move Protocol-Specific Files from lib/ to protocols/

**Time**: 2 hours

```bash
# Suilend
mv src/lib/suilend/calculators.ts src/protocols/suilend/
mv src/lib/suilend/const.ts src/protocols/suilend/constants.ts
mv src/lib/suilend/suilend.ts src/protocols/suilend/types.ts

# Scallop
mv src/lib/scallop/flash-loan-client.ts src/protocols/scallop/flash-loan.ts

# Update imports across codebase
# sdk.ts, strategies/*.ts, etc.
```

**Verification**:
- [ ] All files moved
- [ ] All imports updated
- [ ] `npm run build` succeeds
- [ ] `npm run example:leverage` works

---

### Task 1.2: Split Scallop Adapter

**Time**: 4 hours

**Step 1: Create protocols/scallop/obligation.ts**

Extract obligation management methods:
```typescript
export class ObligationManager {
  constructor(
    private suiClient: SuiClient,
    private scallopClient: Scallop
  ) {}

  async getObligations(address: string): Promise<ScallopObligation[]>

  unstakeObligation(
    tx: Transaction,
    obligationId: string,
    obligationKeyId: string
  ): void

  async getObligationDetails(
    address: string
  ): Promise<ObligationDetails | null>
}
```

**Step 2: Create protocols/scallop/operations.ts**

Extract deposit/borrow/repay/withdraw:
```typescript
export class ScallopOperations {
  constructor(
    private suiClient: SuiClient,
    private scallopClient: Scallop,
    private obligationManager: ObligationManager
  ) {}

  async deposit(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string
  ): Promise<void>

  async borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string
  ): Promise<any>

  async repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string
  ): Promise<void>

  async withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string
  ): Promise<any>
}
```

**Step 3: Create protocols/scallop/flash-loan.ts**

Move from `lib/scallop/flash-loan-client.ts` (already exists)

**Step 4: Refactor protocols/scallop/adapter.ts**

```typescript
export class ScallopAdapter implements ILendingProtocol {
  readonly name = "scallop";
  readonly consumesRepaymentCoin = true;

  private suiClient!: SuiClient;
  private scallopClient!: Scallop;
  private obligationManager!: ObligationManager;
  private operations!: ScallopOperations;
  private initialized = false;

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;
    this.scallopClient = new Scallop({ ... });
    await this.scallopClient.init();

    this.obligationManager = new ObligationManager(suiClient, this.scallopClient);
    this.operations = new ScallopOperations(suiClient, this.scallopClient, this.obligationManager);

    this.initialized = true;
  }

  // Delegate to obligationManager
  async getObligations(address: string) {
    return this.obligationManager.getObligations(address);
  }

  // Delegate to operations
  async deposit(tx: Transaction, coinType: string, coin: any, userAddress: string) {
    return this.operations.deposit(tx, coinType, coin, userAddress);
  }

  // Other ILendingProtocol methods...
}
```

**Verification**:
- [ ] Scallop adapter split into 4 files
- [ ] All methods work (delegate pattern)
- [ ] `npm run build` succeeds
- [ ] `npm run example:leverage` with Scallop works

---

### Task 1.3: Extract Protocol-Specific Types

**Time**: 1 hour

Create `protocols/[protocol]/types.ts` for each protocol:

```typescript
// protocols/suilend/types.ts
export interface SuilendObligation {
  id: string;
  deposits: Deposit[];
  borrows: Borrow[];
  // ...
}

// protocols/scallop/types.ts
export interface ScallopObligation {
  id: string;
  keyId: string;
  locked: boolean;
  collaterals: Collateral[];
  debts: Debt[];
  // ...
}

// protocols/navi/types.ts
export interface NaviLendingState {
  // ...
}
```

**Verification**:
- [ ] Types extracted
- [ ] Imports updated
- [ ] `npm run build` succeeds

---

## 📋 Phase 2: Code Quality (Day 2)

### Task 2.1: Consolidate Coin/Amount Utilities

**Time**: 2 hours

**Current duplication**:
- `utils/coin.ts` - `normalizeCoinType()`
- `utils/format.ts` - `formatUnits()`
- `utils/calculations.ts` - amount calculations
- `parseUnits()` in multiple files

**Consolidate into `utils/coin.ts`**:

```typescript
// utils/coin.ts
import { normalizeStructTag } from "@mysten/sui/utils";

/**
 * Normalize coin type to full 64-char address format
 */
export function normalizeCoinType(coinType: string): string {
  // ...
}

/**
 * Parse human-readable amount to raw units
 * @example parseUnits("1.5", 8) => 150000000n
 */
export function parseUnits(amount: string, decimals: number): bigint {
  // ...
}

/**
 * Format raw units to human-readable amount
 * @example formatUnits(150000000n, 8) => "1.5"
 */
export function formatUnits(amount: bigint, decimals: number): string {
  // ...
}

/**
 * Convert raw amount to USD value
 */
export function toUsdValue(
  amount: bigint,
  decimals: number,
  price: number
): number {
  return Number(formatUnits(amount, decimals)) * price;
}
```

**Delete duplicate functions from**:
- `utils/format.ts` (keep only display helpers)
- `utils/calculations.ts` (keep only complex calculations)

**Verification**:
- [ ] All coin/amount utils in one file
- [ ] Imports updated across codebase
- [ ] `npm run build` succeeds
- [ ] All 3 examples work

---

### Task 2.2: Clean up SDK.ts

**Time**: 1 hour

**Remove**:
- Unused imports (e.g., `Scallop` from `@scallop-io/sui-scallop-sdk`)
- Dead code
- Commented-out code

**Reorganize**:
```typescript
export class DefiDashSDK {
  // Properties
  private suiClient!: SuiClient;
  private keypair?: Ed25519Keypair;
  // ...

  // Constructor
  constructor(options: SDKOptions = {}) { }

  // Public methods (alphabetical)
  async deleverage(params: DeleverageParams): Promise<StrategyResult> { }

  async getAggregatedPortfolio(): Promise<AccountPortfolio[]> { }

  async getPosition(protocol: LendingProtocol): Promise<PositionInfo | null> { }

  async initialize(suiClient: SuiClient, keypairOrAddress: Ed25519Keypair | string) { }

  async leverage(params: LeverageParams): Promise<StrategyResult> { }

  async previewLeverage(params: Omit<LeverageParams, 'protocol'>): Promise<LeveragePreview> { }

  // Private helpers (alphabetical)
  private ensureInitialized(): void { }

  private getProtocol(protocol: LendingProtocol): ILendingProtocol { }

  private get userAddress(): string { }
}
```

**Verification**:
- [ ] SDK.ts organized
- [ ] No unused imports
- [ ] `npm run build` succeeds

---

### Task 2.3: Standardize Error Messages

**Time**: 1 hour

**Current inconsistency**:
```typescript
throw new Error("No obligation found")
throw new Error("Position not found")
throw new Error("Protocol not supported")
```

**Standardize**:
```typescript
// In protocols/base.ts
export class ProtocolError extends Error {
  constructor(protocol: string, message: string) {
    super(`[${protocol}] ${message}`);
    this.name = 'ProtocolError';
  }
}

// Usage
throw new ProtocolError('scallop', `No obligation found for ${address}`);
throw new ProtocolError('suilend', `Oracle price stale for ${coinType}`);
```

**Verification**:
- [ ] All protocol errors use ProtocolError
- [ ] Error messages include context (protocol, address, etc.)
- [ ] `npm run build` succeeds

---

### Task 2.4: Replace console.log with Logger

**Time**: 1 hour

**Find all console.log**:
```bash
grep -r "console\.log\|console\.error\|console\.warn" src/ --include="*.ts"
# 48 occurrences
```

**Replace with logger**:
```typescript
// Before
console.log("Fetching position...");
console.error("Failed to fetch position");

// After
import { logger } from "./utils/logger";
logger.info("Fetching position...");
logger.error("Failed to fetch position");
```

**Keep console.log ONLY in**:
- Example files (`examples/*.ts`)
- Logger utility itself (`utils/logger.ts`)

**Verification**:
- [ ] No console.log in src/ (except logger.ts)
- [ ] All logs use logger utility
- [ ] `npm run build` succeeds

---

## 📋 Phase 3: Type Safety & Optimization (Day 3)

### Task 3.1: Add JSDoc to Public APIs

**Time**: 2 hours

Add JSDoc to all public methods in `sdk.ts`:

```typescript
/**
 * Execute leverage strategy
 *
 * Opens a leveraged position by:
 * 1. Taking a flash loan
 * 2. Swapping to collateral asset
 * 3. Depositing collateral
 * 4. Borrowing to repay flash loan
 *
 * @param params - Leverage parameters
 * @param params.protocol - Lending protocol (suilend, navi, scallop)
 * @param params.depositAsset - Asset symbol (e.g., 'LBTC') or full coin type
 * @param params.depositAmount - Amount in human-readable format (e.g., '0.001')
 * @param params.depositValueUsd - Alternative: USD value to deposit
 * @param params.multiplier - Leverage multiplier (1.5 - 5.0)
 * @param params.dryRun - If true, simulate without executing
 *
 * @returns Strategy execution result
 * @returns result.success - Whether strategy succeeded
 * @returns result.txDigest - Transaction hash (if executed)
 * @returns result.gasUsed - Gas used in MIST (if executed)
 * @returns result.error - Error message (if failed)
 *
 * @throws {Error} If SDK not initialized
 * @throws {ProtocolError} If protocol operation fails
 *
 * @example
 * ```typescript
 * const result = await sdk.leverage({
 *   protocol: LendingProtocol.Suilend,
 *   depositAsset: 'LBTC',
 *   depositAmount: '0.001',
 *   multiplier: 2.0,
 *   dryRun: false
 * });
 *
 * if (result.success) {
 *   console.log(`Transaction: ${result.txDigest}`);
 *   console.log(`Gas used: ${result.gasUsed} MIST`);
 * }
 * ```
 */
async leverage(params: LeverageParams): Promise<StrategyResult>
```

Apply to:
- `leverage()`
- `deleverage()`
- `getPosition()`
- `getAggregatedPortfolio()`
- `previewLeverage()`
- `initialize()`

**Verification**:
- [ ] All public methods have JSDoc
- [ ] JSDoc includes examples
- [ ] TypeDoc can generate docs
- [ ] `npm run build` succeeds

---

### Task 3.2: Create Base Protocol Adapter

**Time**: 2 hours

```typescript
// protocols/base.ts
import { SuiClient } from "@mysten/sui/client";
import { ILendingProtocol } from "../types";

export abstract class BaseProtocolAdapter implements ILendingProtocol {
  protected suiClient!: SuiClient;
  protected initialized = false;

  abstract readonly name: string;
  abstract readonly consumesRepaymentCoin: boolean;

  /**
   * Ensure adapter is initialized before use
   */
  protected ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(`${this.name} adapter not initialized. Call initialize() first.`);
    }
  }

  /**
   * Get first obligation for address
   * @throws {ProtocolError} If no obligation found
   */
  protected async getFirstObligation(address: string): Promise<any> {
    const obligations = await this.getObligations(address);
    if (obligations.length === 0) {
      throw new ProtocolError(this.name, `No obligation found for ${address}`);
    }
    return obligations[0];
  }

  // Abstract methods that must be implemented
  abstract initialize(suiClient: SuiClient): Promise<void>;
  abstract getPosition(userAddress: string): Promise<PositionInfo | null>;
  abstract getObligations(userAddress: string): Promise<any[]>;
  // ... other ILendingProtocol methods
}
```

**Update adapters to extend BaseProtocolAdapter**:

```typescript
// protocols/suilend/adapter.ts
export class SuilendAdapter extends BaseProtocolAdapter {
  readonly name = "suilend";
  readonly consumesRepaymentCoin = false;

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;
    // ...
    this.initialized = true;
  }

  async getPosition(userAddress: string): Promise<PositionInfo | null> {
    this.ensureInitialized(); // Use base class helper
    // ...
  }
}
```

**Verification**:
- [ ] All adapters extend BaseProtocolAdapter
- [ ] Common logic deduplicated
- [ ] `npm run build` succeeds
- [ ] All 3 examples work

---

### Task 3.3: Simplify Strategy Builders

**Time**: 2 hours

**Reduce nesting with guard clauses**:

```typescript
// Before
async function buildLeverageTransaction(...) {
  if (condition1) {
    if (condition2) {
      if (condition3) {
        // nested logic
      }
    }
  }
}

// After
async function buildLeverageTransaction(...) {
  if (!condition1) {
    throw new Error("condition1 failed");
  }
  if (!condition2) {
    throw new Error("condition2 failed");
  }
  if (!condition3) {
    throw new Error("condition3 failed");
  }

  // flat logic
}
```

**Extract helper functions**:

```typescript
// strategies/leverage.ts

// Extract
async function getSwapQuote(
  swapClient: MetaAg,
  amountIn: string,
  coinTypeIn: string,
  coinTypeOut: string
): Promise<SwapQuote> {
  const quotes = await swapClient.quote({ amountIn, coinTypeIn, coinTypeOut });
  if (quotes.length === 0) {
    throw new Error(`No swap quotes for ${coinTypeIn} → ${coinTypeOut}`);
  }
  return quotes.sort((a, b) => Number(b.amountOut) - Number(a.amountOut))[0];
}

// Use
const quote = await getSwapQuote(swapClient, amount, collateralType, USDC_COIN_TYPE);
```

**Verification**:
- [ ] Strategy files more readable
- [ ] Nesting reduced
- [ ] Helper functions extracted
- [ ] `npm run build` succeeds

---

### Task 3.4: Extract Gas Optimization Logic

**Time**: 1 hour

```typescript
// utils/gas.ts
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";

/**
 * Optimize gas budget via dry run
 *
 * @param tx - Transaction to optimize
 * @param client - Sui client
 * @returns Optimized gas budget (actual + 20% buffer)
 */
export async function optimizeGasBudget(
  tx: Transaction,
  client: SuiClient
): Promise<bigint> {
  // Set high budget for dry run
  tx.setGasBudget(500_000_000);

  // Dry run to get actual gas usage
  const dryRunResult = await client.dryRunTransactionBlock({
    transactionBlock: await tx.build({ client }),
  });

  // Calculate optimized budget
  const computationCost = BigInt(dryRunResult.effects.gasUsed.computationCost);
  const storageCost = BigInt(dryRunResult.effects.gasUsed.storageCost);
  const storageRebate = BigInt(dryRunResult.effects.gasUsed.storageRebate);
  const estimatedGas = computationCost + storageCost - storageRebate;

  // Add 20% buffer
  return (estimatedGas * 120n) / 100n;
}

/**
 * Execute transaction with optimized gas
 */
export async function executeWithOptimizedGas(
  tx: Transaction,
  signer: Ed25519Keypair,
  client: SuiClient
): Promise<{ digest: string; gasUsed: bigint }> {
  const optimizedBudget = await optimizeGasBudget(tx, client);
  tx.setGasBudget(optimizedBudget);

  const result = await client.signAndExecuteTransaction({
    signer,
    transaction: tx,
    options: { showEffects: true },
  });

  const gasUsed = BigInt(result.effects?.gasUsed.computationCost || 0) +
                  BigInt(result.effects?.gasUsed.storageCost || 0);

  return {
    digest: result.digest,
    gasUsed,
  };
}
```

**Use in sdk.ts**:

```typescript
import { executeWithOptimizedGas } from "./utils/gas";

async leverage(params: LeverageParams): Promise<StrategyResult> {
  // ... build transaction ...

  if (!params.dryRun) {
    const { digest, gasUsed } = await executeWithOptimizedGas(tx, this.keypair!, this.suiClient);
    return { success: true, txDigest: digest, gasUsed };
  }
  // ...
}
```

**Verification**:
- [ ] Gas logic extracted to utils/gas.ts
- [ ] Used in sdk.ts
- [ ] `npm run build` succeeds
- [ ] Gas optimization still works

---

### Task 3.5: Consolidate Obligation Handling

**Time**: 1 hour

**Add to BaseProtocolAdapter**:

```typescript
// protocols/base.ts
export abstract class BaseProtocolAdapter {
  // ...

  /**
   * Get first obligation or throw
   */
  protected async getFirstObligation(address: string): Promise<any> {
    this.ensureInitialized();
    const obligations = await this.getObligations(address);
    if (obligations.length === 0) {
      throw new ProtocolError(
        this.name,
        `No obligation found for address ${address}`
      );
    }
    return obligations[0];
  }
}
```

**Use in adapters**:

```typescript
// protocols/scallop/adapter.ts
async getPosition(userAddress: string): Promise<PositionInfo | null> {
  try {
    const obligation = await this.getFirstObligation(userAddress); // Use base method
    // ... parse position ...
  } catch (error) {
    if (error instanceof ProtocolError) {
      return null; // No position
    }
    throw error;
  }
}
```

**Verification**:
- [ ] Common obligation pattern in base class
- [ ] All adapters use it
- [ ] `npm run build` succeeds

---

### Task 3.6: Remove 'as any' Casts

**Time**: 2 hours

**Find all 'as any'**:
```bash
grep -r "as any" src/ --include="*.ts"
# 13+ occurrences
```

**Replace with proper types**:

```typescript
// Before
const scallopAdapter = protocol as any;
loanCoin as any

// After
import { ScallopAdapter } from "./protocols/scallop";
import type { TransactionArgument } from "@mysten/sui/transactions";

const scallopAdapter = protocol as ScallopAdapter;
loanCoin as TransactionArgument
```

**Add type guards where needed**:

```typescript
function isScallopAdapter(protocol: ILendingProtocol): protocol is ScallopAdapter {
  return protocol.name === "scallop";
}

if (isScallopAdapter(protocol)) {
  // TypeScript knows protocol is ScallopAdapter here
  const addresses = protocol.getAddresses();
}
```

**Verification**:
- [ ] No 'as any' in src/
- [ ] Proper type assertions or guards
- [ ] `npm run build` succeeds with no type errors

---

## 📋 Phase 4: Verification (Day 3 afternoon)

### Task 4.1: Test All 3 Core Examples

**Time**: 1 hour

**Setup**:
```bash
# Ensure .env is configured
cp .env.example .env
# Edit .env with real SECRET_KEY
```

**Test 1: Portfolio**
```bash
npm run example:portfolio
```
Expected output:
- Shows Suilend positions
- Shows Scallop positions
- Shows Navi positions
- No errors

**Test 2: Leverage (dry run)**
```bash
TX_MODE=dryrun npm run example:leverage
```
Expected output:
- Preview shows leverage calculation
- Dry run succeeds
- No execution

**Test 3: Leverage (execution on testnet/devnet)**
```bash
# Set to testnet first
export SUI_FULLNODE_URL=https://fullnode.testnet.sui.io:443
TX_MODE=exec npm run example:leverage
```
Expected output:
- Transaction executes
- Gas used displayed
- Position created

**Test 4: Deleverage**
```bash
TX_MODE=exec npm run example:deleverage
```
Expected output:
- Position closed
- Collateral returned
- Gas used displayed

**Verification**:
- [ ] example:portfolio works
- [ ] example:leverage (dryrun) works
- [ ] example:leverage (exec) works on testnet
- [ ] example:deleverage works
- [ ] No errors or warnings
- [ ] Output is clean and informative

---

## 🎯 Success Criteria

### Code Quality
- [ ] No files > 500 lines (except generated types)
- [ ] No 'as any' casts in src/
- [ ] No console.log in src/ (except logger.ts)
- [ ] All public APIs have JSDoc
- [ ] Consistent error messages

### Structure
- [ ] Clear separation: protocols/ vs strategies/ vs utils/
- [ ] No lib/ directory (moved to protocols/)
- [ ] Protocol-specific code in protocols/[name]/
- [ ] Common utilities in utils/

### Functionality
- [ ] All 3 examples work
- [ ] Gas optimization works
- [ ] Support for Suilend, Navi, Scallop
- [ ] No regressions

### Build & Types
- [ ] `npm run build` succeeds
- [ ] No TypeScript errors
- [ ] Types exported correctly
- [ ] dist/ contains all necessary files

---

## 📊 Metrics

### Before Refactoring
- Scallop adapter: 1075 lines
- Total files in src/: 26
- console.log count: 48
- 'as any' casts: 13+
- Largest file: protocols/scallop.ts (1075 lines)

### After Refactoring (Target)
- Scallop adapter: ~300 lines (split into 4 files)
- Total files in src/: ~35 (more files, smaller each)
- console.log count: 0 (in src/, excluding logger.ts)
- 'as any' casts: 0
- Largest file: <500 lines

---

## 🚧 Risks & Mitigation

### Risk 1: Breaking Changes During Refactoring
**Mitigation**: Test examples after each phase

### Risk 2: Import Path Chaos
**Mitigation**: Use search-replace carefully, test build frequently

### Risk 3: Loss of Functionality
**Mitigation**: Keep old files until new ones are verified working

### Risk 4: Type Errors After Removing 'as any'
**Mitigation**: Add proper type definitions, use type guards

---

## 📝 Notes

- Keep git commits small and atomic
- Run `npm run build` after each task
- Test examples at end of each day
- Don't delete old files until new structure is verified
- Document any breaking changes in CHANGELOG.md (if created)

---

## 🔄 Rollback Plan

If refactoring fails:
1. Revert to last working commit
2. Keep TODO list for future attempt
3. Document what went wrong

Git workflow:
```bash
# Create refactoring branch
git checkout -b refactor/sdk-cleanup

# Make changes, commit frequently
git add .
git commit -m "refactor: move lib/suilend to protocols/suilend"

# If something breaks
git reset --hard HEAD~1  # Undo last commit
```

---

**Last Updated**: 2026-02-02
**Status**: Planning
**Owner**: @sdk-specialist
