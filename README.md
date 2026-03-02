# DefiDash SDK

Multi-protocol DeFi SDK for Sui blockchain — **leverage lending strategies** with minimal friction.

## Why Leverage Lending?

**Leverage lending is a powerful DeFi primitive for long-term asset appreciation.**

If you believe certain assets like **BTC** will trend upward over time despite short-term volatility, leverage lending allows you to:

- **Multiply your profit exposure** — instead of holding 1x BTC, hold 2x or 3x
- **Maintain a stable position** — unlike perpetual futures, no funding rates eating into your position
- **Lower costs** — no recurring fees, only the spread between borrow/supply APY
- **Composable on-chain** — fully transparent, no CEX counterparty risk

### Leverage Lending vs Perpetual Futures

| Aspect                | Leverage Lending        | Perpetual Futures        |
| --------------------- | ----------------------- | ------------------------ |
| **Funding Rate**      | None                    | -0.01% ~ +0.03% every 8h |
| **Ongoing Costs**     | Borrow APY - Supply APY | Funding + Trading Fees   |
| **Liquidation**       | Collateral-based LTV    | Margin-based             |
| **Counterparty**      | On-chain protocol       | Exchange (CEX/DEX)       |
| **Position Duration** | Unlimited               | Funding rate dependent   |

> **TL;DR**: If you're bullish on an asset long-term, leverage lending is more capital-efficient than perpetual futures.

---

## What is DefiDash SDK?

DefiDash SDK is a **DeFi Saver-like toolkit** for Sui blockchain. It abstracts complex multi-protocol interactions into simple function calls.

### Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Leverage Strategy (Single PTB)                    │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐   │
│  │  1. Flash Loan  │───▶│  2. Swap        │───▶│  3. Lending     │   │
│  │   (Scallop)     │    │   (7k Protocol) │    │   (Multi-proto) │   │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘   │
│         │                                              │              │
│         └────────────── Borrow to Repay ◀──────────────┘              │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**How it works:**

1. **Flash Loan** — Borrow USDC from Scallop (no collateral needed)
2. **Swap** — Convert USDC to collateral asset (XBTC, SUI, etc.) via 7k Aggregator
3. **Deposit** — Deposit collateral into lending protocol
4. **Borrow** — Borrow USDC against collateral to repay flash loan

All steps execute atomically in a single Sui Programmable Transaction Block (PTB).

---

## Supported Protocols

| Component           | Protocols              |
| ------------------- | ---------------------- |
| **Flash Loan**      | Scallop                |
| **Swap Aggregator** | 7k Protocol            |
| **Lending**         | Suilend, Navi, Scallop |

---

## Installation

```bash
npm install defi-dash-sdk
```

## Quick Start

### Node.js

```typescript
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { DefiDashSDK, LendingProtocol } from "defi-dash-sdk";

// Initialize
const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });
const keypair = Ed25519Keypair.fromSecretKey(YOUR_SECRET_KEY);
const sdk = await DefiDashSDK.create(suiClient, keypair);

// Build + Execute 2x leverage on XBTC
const tx = new Transaction();
tx.setSender(keypair.getPublicKey().toSuiAddress());

await sdk.buildLeverageTransaction(tx, {
  protocol: LendingProtocol.Suilend,
  depositAsset: "XBTC",
  depositValueUsd: 100,
  multiplier: 2.0,
});

const result = await sdk.execute(tx); // or sdk.dryRun(tx) to simulate
console.log(result.txDigest);

// Close position
const tx2 = new Transaction();
tx2.setSender(keypair.getPublicKey().toSuiAddress());
await sdk.buildDeleverageTransaction(tx2, {
  protocol: LendingProtocol.Suilend,
});
await sdk.execute(tx2);
```

### Browser

```typescript
// No keypair needed — pass wallet address
const sdk = await DefiDashSDK.create(suiClient, walletAddress);

const tx = new Transaction();
tx.setSender(walletAddress);
await sdk.buildLeverageTransaction(tx, {
  protocol: LendingProtocol.Suilend,
  depositAsset: "XBTC",
  depositValueUsd: 100,
  multiplier: 2.0,
});

// Sign with wallet adapter (e.g., @mysten/dapp-kit)
await signAndExecute({ transaction: tx });
```

---

## API Reference

### `DefiDashSDK`

```typescript
class DefiDashSDK {
  // Initialize (static factory — no constructor)
  static create(
    suiClient: SuiClient,
    keypairOrAddress: Ed25519Keypair | string,
    options?: SDKOptions,
  ): Promise<DefiDashSDK>;

  // Build transactions (browser & Node.js)
  buildLeverageTransaction(tx: Transaction, params: BrowserLeverageParams): Promise<void>;
  buildDeleverageTransaction(tx: Transaction, params: BrowserDeleverageParams): Promise<void>;

  // Preview & Route finding
  previewLeverage(params: PreviewLeverageParams): Promise<LeveragePreview>;
  findBestLeverageRoute(params: FindBestRouteParams): Promise<LeverageRouteResult>;

  // Position queries
  getPosition(protocol: LendingProtocol): Promise<PositionInfo | null>;
  getOpenPositions(): Promise<Array<{ protocol: LendingProtocol; position: PositionInfo }>>;
  getAggregatedPortfolio(): Promise<AccountPortfolio[]>;

  // Utilities
  getTokenPrice(asset: string): Promise<number>;
  getSuiClient(): SuiClient;
  getUserAddress(): string;

  // Execute (Node.js only, requires keypair)
  dryRun(tx: Transaction): Promise<StrategyResult>;
  execute(tx: Transaction): Promise<StrategyResult>;
}
```

### Key Types

```typescript
enum LendingProtocol {
  Suilend = "suilend",
  Navi = "navi",
  Scallop = "scallop",
}

interface BrowserLeverageParams {
  protocol: LendingProtocol;
  depositAsset: string;        // "XBTC", "SUI", or full coin type
  depositAmount?: string;      // Raw amount (e.g., "100000") — either this or depositValueUsd
  depositValueUsd?: number;    // USD value (e.g., 100) — either this or depositAmount
  multiplier: number;          // 1.5, 2.0, 3.0, etc.
}

interface BrowserDeleverageParams {
  protocol: LendingProtocol;
}

interface StrategyResult {
  success: boolean;
  txDigest?: string;
  gasUsed?: bigint;
  error?: string;
}
```

### Preview & Route Finding

```typescript
// Compare all protocols for a given asset
const route = await sdk.findBestLeverageRoute({
  depositAsset: "XBTC",
  depositValueUsd: 100,
});

console.log(route.safeMultiplier);                  // e.g., 2.00
console.log(route.bestMaxMultiplier.protocol);      // e.g., "scallop"
console.log(route.bestApy.protocol);                // e.g., "suilend"

// Preview a specific protocol
const preview = await sdk.previewLeverage({
  protocol: LendingProtocol.Suilend,
  depositAsset: "XBTC",
  depositValueUsd: 100,
  multiplier: 2.0,
});

console.log(preview.totalPositionUsd);   // $200
console.log(preview.maxMultiplier);      // 2.50x
console.log(preview.liquidationPrice);   // $51,244
console.log(preview.netApy);             // 0.04 (4%)
```

### Position Queries

```typescript
// Single protocol position
const position = await sdk.getPosition(LendingProtocol.Suilend);

// All open positions (for strategy operations)
const positions = await sdk.getOpenPositions();
for (const { protocol, position } of positions) {
  console.log(`[${protocol}] Net: $${position.netValueUsd}`);
}

// Full portfolio with APY data (for dashboards)
const portfolios = await sdk.getAggregatedPortfolio();
for (const p of portfolios) {
  console.log(`[${p.protocol}] HF: ${p.healthFactor} | Net: $${p.netValueUsd}`);
}
```

---

## Examples

See [`examples/`](examples/) for full working examples:

| File | Description |
|------|-------------|
| `leverage.ts` | Build and execute a leverage position |
| `deleverage.ts` | Close a leverage position |
| `preview_leverage.ts` | Preview leverage parameters before executing |
| `find_best_route.ts` | Compare protocols and find optimal route |
| `get_portfolio.ts` | Query positions and portfolio across protocols |

```bash
# Setup environment
cp .env.example .env
# Edit .env with your secret key

# Run examples
npm run example:leverage
npm run example:deleverage
```

---

## E2E Testing

Full cycle test across all protocols: Preview → Leverage → Portfolio → Deleverage

```bash
# Dry run (simulation only)
npm run e2e

# Execute on-chain (real transactions, gas costs apply)
npm run e2e:execute

# Partial runs
npm run e2e:leverage              # leverage only (dryrun)
npm run e2e:leverage:execute      # leverage only (execute)
npm run e2e:deleverage            # deleverage only (dryrun)
npm run e2e:deleverage:execute    # deleverage only (execute)
```

---

## Project Structure

```
defi-dash-sdk/
├── src/
│   ├── index.ts              # Public API exports
│   ├── sdk.ts                # DefiDashSDK class
│   ├── types/                # TypeScript types & constants
│   ├── protocols/            # Protocol adapters
│   │   ├── base-adapter.ts   # Abstract base (compile-time enforcement)
│   │   ├── suilend/
│   │   ├── navi/
│   │   └── scallop/
│   ├── strategies/           # Strategy builders
│   │   ├── leverage.ts
│   │   ├── deleverage.ts
│   │   ├── leverage-preview.ts
│   │   └── leverage-route.ts
│   ├── utils/                # Internal utilities
│   └── __tests__/            # Unit & integration tests
├── examples/                 # SDK usage examples
├── scripts/                  # E2E test scripts
└── docs/                     # SDK documentation
    ├── sdk-methods/          # Method-level docs
    └── adding-new-protocol.md
```

### Adding New Protocols

New lending protocols can be added by extending `BaseProtocolAdapter`. The abstract class enforces compile-time method implementation — missing any required method produces a TypeScript build error.

See [`docs/adding-new-protocol.md`](docs/adding-new-protocol.md) for the full guide.

---

## Environment Variables

| Variable                     | Description                    | Default   |
| ---------------------------- | ------------------------------ | --------- |
| `SECRET_KEY`                 | Sui wallet secret key (base64) | Required  |
| `SUI_FULLNODE_URL`           | Custom RPC endpoint            | Mainnet   |
| `LEVERAGE_PROTOCOL`          | `suilend`, `navi`, or `scallop`| `suilend` |
| `LEVERAGE_DEPOSIT_COIN_TYPE` | Asset symbol or coin type      | `XBTC`    |
| `LEVERAGE_DEPOSIT_AMOUNT`    | Amount in raw units            | `1000`    |
| `LEVERAGE_MULTIPLIER`        | Leverage multiplier            | `2`       |
| `TX_MODE`                    | `dryrun` or `exec`             | `dryrun`  |

---

## License

[MIT](LICENSE)
