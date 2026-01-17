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
│  │   (Scallop)     │    │   (7k Protocol) │    │   (Suilend/Navi)│   │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘   │
│         │                                              │              │
│         └────────────── Borrow to Repay ◀──────────────┘              │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**How it works:**

1. **Flash Loan** — Borrow USDC from Scallop (no collateral needed)
2. **Swap** — Convert USDC to collateral asset (LBTC, SUI, etc.) via 7k Aggregator
3. **Deposit** — Deposit collateral into lending protocol (Suilend or Navi)
4. **Borrow** — Borrow USDC against collateral to repay flash loan

All steps execute atomically in a single Sui Programmable Transaction Block (PTB).

---

## Installation

```bash
npm install defi-dash-sdk
```

## Quick Start

```typescript
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { DefiDashSDK, LendingProtocol } from "defi-dash-sdk";

// Initialize
const suiClient = new SuiClient({ url: getFullnodeUrl("mainnet") });
const keypair = Ed25519Keypair.fromSecretKey(YOUR_SECRET_KEY);

const sdk = new DefiDashSDK();
await sdk.initialize(suiClient, keypair);

// Execute 2x leverage on LBTC
const result = await sdk.leverage({
  protocol: LendingProtocol.Suilend,
  depositAsset: "LBTC",
  depositAmount: "0.001",  // Human-readable
  multiplier: 2.0,
  dryRun: false,           // Set true to simulate
});

console.log(result.txDigest); // Transaction hash

// Close position
await sdk.deleverage({
  protocol: LendingProtocol.Suilend,
  dryRun: false,
});
```

---

## Supported Protocols

| Component           | Protocols     |
| ------------------- | ------------- |
| **Flash Loan**      | Scallop       |
| **Swap Aggregator** | 7k Protocol   |
| **Lending**         | Suilend, Navi |

---

## Examples

See `examples/` folder for full working examples:

```bash
# Setup environment
cp .env.example .env.test
# Edit .env.test with your secret key

# Run leverage example (dry run by default)
npm run example:leverage

# Run deleverage example
npm run example:deleverage
```

### Environment Variables

| Variable                     | Description                    | Default   |
| ---------------------------- | ------------------------------ | --------- |
| `SECRET_KEY`                 | Sui wallet secret key (base64) | Required  |
| `LEVERAGE_PROTOCOL`          | `suilend` or `navi`            | `suilend` |
| `LEVERAGE_DEPOSIT_COIN_TYPE` | Asset symbol or coin type      | `LBTC`    |
| `LEVERAGE_DEPOSIT_AMOUNT`    | Amount in raw units            | `1000`    |
| `LEVERAGE_MULTIPLIER`        | Leverage multiplier            | `2`       |
| `TX_MODE`                    | `dryrun` or `exec`             | `dryrun`  |

---

## API Reference

### `DefiDashSDK`

```typescript
class DefiDashSDK {
  // Initialize with Sui client and keypair
  initialize(suiClient: SuiClient, keypair: Ed25519Keypair): Promise<void>;

  // Open leveraged position
  leverage(params: LeverageParams): Promise<StrategyResult>;

  // Close leveraged position
  deleverage(params: DeleverageParams): Promise<StrategyResult>;

  // Get current position
  getPosition(protocol: LendingProtocol): Promise<PositionInfo | null>;

  // Preview leverage before execution
  previewLeverage(params): Promise<LeveragePreview>;
}
```

### Types

```typescript
enum LendingProtocol {
  Suilend = "suilend",
  Navi = "navi",
}

interface LeverageParams {
  protocol: LendingProtocol;
  depositAsset: string;      // "LBTC" or full coin type
  depositAmount: string;     // Human-readable, e.g., "0.001"
  multiplier: number;        // 1.5, 2.0, 3.0, etc.
  dryRun?: boolean;
}

interface StrategyResult {
  success: boolean;
  txDigest?: string;
  gasUsed?: bigint;
  error?: string;
}
```

---

## Development Scripts

For debugging and testing individual protocol integrations:

```bash
# Setup
cp .env.scripts.example .env.scripts

# Suilend scripts
npm run script:suilend-leverage
npm run script:suilend-deleverage

# Navi scripts
npm run script:navi-leverage
npm run script:navi-deleverage

# Scallop flash loan
npm run script:scallop-flashloan

# 7k swap
npm run script:swap
```

---

## Project Structure

```
defi-dash-sdk/
├── src/
│   ├── index.ts          # SDK entry point
│   ├── sdk.ts            # DefiDashSDK class
│   ├── types.ts          # TypeScript types
│   ├── protocols/        # Protocol adapters
│   │   ├── suilend.ts
│   │   └── navi.ts
│   ├── strategies/       # Strategy builders
│   │   ├── leverage.ts
│   │   └── deleverage.ts
│   └── lib/              # Utilities
├── examples/             # SDK usage examples
│   ├── leverage.ts
│   └── deleverage.ts
└── scripts/              # Development scripts
    ├── suilend/
    ├── navi/
    ├── scallop/
    └── 7k/
```

---

## License

MIT
