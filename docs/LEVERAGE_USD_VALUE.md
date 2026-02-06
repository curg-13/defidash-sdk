# Leverage USD Value Support

## Overview

The SDK now supports two ways to specify deposit amounts for leverage positions:

1. **`depositAmount`** - Exact token amount (e.g., "0.00001" LBTC)
2. **`depositValueUsd`** - USD value (e.g., 1.0 for $1 worth)

## Usage

### Option 1: Exact Token Amount

```typescript
await sdk.leverage({
  protocol: LendingProtocol.Suilend,
  depositAsset: "LBTC",
  depositAmount: "0.00001",  // Exactly 0.00001 LBTC
  multiplier: 2.0,
  dryRun: true
});
```

### Option 2: USD Value (Recommended for most users)

```typescript
await sdk.leverage({
  protocol: LendingProtocol.Suilend,
  depositAsset: "LBTC",
  depositValueUsd: 1.0,  // $1 worth of LBTC (auto-calculated)
  multiplier: 2.0,
  dryRun: true
});
```

## Environment Variables

### `.env` Configuration

```bash
# Option 1: Use raw amount (in smallest units)
LEVERAGE_DEPOSIT_AMOUNT=1000  # 1000 = 0.00001 LBTC (8 decimals)

# Option 2: Use USD value (recommended)
LEVERAGE_DEPOSIT_VALUE_USD=1.0  # $1 worth of LBTC

# Note: Set ONLY ONE of the above
```

## Implementation Details

### Files Modified

1. **`src/types/strategy.ts`** - Updated `LeverageParams` interface
2. **`src/types/config.ts`** - Updated `BrowserLeverageParams` interface
3. **`src/sdk.ts`** - Added conversion logic in:
   - `buildLeverageTransaction()`
   - `previewLeverage()`
4. **`examples/leverage.ts`** - Updated to support both options
5. **`.env.example`** - Documented both configuration methods

### Validation

The SDK validates that:

- ✅ Exactly ONE of `depositAmount` or `depositValueUsd` is provided
- ❌ Error if both are provided
- ❌ Error if neither is provided

### Price Source

USD value conversion uses `@7kprotocol/sdk-ts`'s `getTokenPrice()` function, ensuring consistency with:

- Preview calculations
- Flash loan amount calculations
- All other SDK price-dependent operations

## Examples

Run the comprehensive examples:

```bash
npm run build
node dist/examples/leverage_examples.js
```

This demonstrates:

1. Using exact token amount
2. Using USD value
3. Comparing different assets with same USD value
4. Error handling

## Benefits

### For Users

- 💰 **Intuitive**: Think in dollars, not decimals
- 🎯 **Consistent**: Same USD value across different assets
- 🔄 **Flexible**: Choose the method that fits your use case

### For Developers

- 🔒 **Type-safe**: Full TypeScript support
- 📊 **Accurate**: Uses same price source as internal calculations
- 🛡️ **Validated**: Prevents invalid parameter combinations
- 🔧 **Reusable**: Works in Node.js, Browser, and CLI contexts

## Migration Guide

### Before (only amount supported)

```typescript
// Had to calculate manually
const price = await getTokenPrice(coinType);
const amount = (1.0 / price).toFixed(8);
await sdk.leverage({ depositAmount: amount, ... });
```

### After (both supported)

```typescript
// Simple and direct
await sdk.leverage({ depositValueUsd: 1.0, ... });

// Or keep using amount if you prefer
await sdk.leverage({ depositAmount: "0.00001", ... });
```

## Future Considerations

- [ ] Consider moving `src/lib/utils` to `src/utils` (directory structure cleanup)
- [ ] Add support for other value denominations (EUR, etc.)
- [ ] Cache price data to reduce API calls
