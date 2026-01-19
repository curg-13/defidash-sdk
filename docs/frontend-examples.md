# DefiDash SDK - Frontend Integration Examples

React + `@mysten/dapp-kit` 기반 프론트엔드에서 SDK 사용 예시입니다.

---

## Setup

```bash
npm install defi-dash-sdk @mysten/dapp-kit @mysten/sui
```

---

## useDefiDash Hook

```tsx
import { useCallback, useRef } from 'react';
import { useCurrentAccount, useSuiClient, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { Transaction } from '@mysten/sui/transactions';
import { DefiDashSDK, LendingProtocol } from 'defi-dash-sdk';

export function useDefiDash() {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const sdkRef = useRef<DefiDashSDK | null>(null);

  // Initialize SDK (lazy)
  const getSDK = useCallback(async () => {
    if (!account?.address) throw new Error('Wallet not connected');

    if (!sdkRef.current) {
      sdkRef.current = new DefiDashSDK();
      await sdkRef.current.initialize(suiClient as any, account.address);
    }
    return sdkRef.current;
  }, [account, suiClient]);

  // Open Leverage Position
  const openLeverage = useCallback(async (params: {
    protocol: LendingProtocol;
    depositAsset: string;
    depositAmount: string;
    multiplier: number;
  }) => {
    const sdk = await getSDK();

    const tx = new Transaction();
    tx.setSender(account!.address);
    tx.setGasBudget(200_000_000);

    await sdk.buildLeverageTransaction(tx, params);

    return signAndExecute({ transaction: tx as any });
  }, [account, getSDK, signAndExecute]);

  // Close Position (Deleverage)
  const closeLeverage = useCallback(async (protocol: LendingProtocol) => {
    const sdk = await getSDK();

    const tx = new Transaction();
    tx.setSender(account!.address);
    tx.setGasBudget(200_000_000);

    await sdk.buildDeleverageTransaction(tx, { protocol });

    return signAndExecute({ transaction: tx as any });
  }, [account, getSDK, signAndExecute]);

  // Get Current Position
  const getPosition = useCallback(async (protocol: LendingProtocol) => {
    const sdk = await getSDK();
    return sdk.getPosition(protocol);
  }, [getSDK]);

  return {
    isConnected: !!account?.address,
    openLeverage,
    closeLeverage,
    getPosition,
  };
}
```

---

## Usage Examples

### Open 2x Leverage Position

```tsx
function OpenPositionButton() {
  const { openLeverage, isConnected } = useDefiDash();
  const [loading, setLoading] = useState(false);

  const handleOpen = async () => {
    setLoading(true);
    try {
      const result = await openLeverage({
        protocol: LendingProtocol.Navi,
        depositAsset: 'LBTC',
        depositAmount: '0.001', // human-readable
        multiplier: 2.0,
      });
      console.log('TX:', result.digest);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleOpen} disabled={!isConnected || loading}>
      {loading ? 'Opening...' : 'Open 2x LBTC Position'}
    </button>
  );
}
```

### Close Position

```tsx
function ClosePositionButton() {
  const { closeLeverage, isConnected } = useDefiDash();
  const [loading, setLoading] = useState(false);

  const handleClose = async () => {
    setLoading(true);
    try {
      const result = await closeLeverage(LendingProtocol.Navi);
      console.log('Position closed:', result.digest);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleClose} disabled={!isConnected || loading}>
      {loading ? 'Closing...' : 'Close Position'}
    </button>
  );
}
```

### Display Current Position

```tsx
function PositionDisplay() {
  const { getPosition, isConnected } = useDefiDash();
  const [position, setPosition] = useState(null);

  useEffect(() => {
    if (isConnected) {
      getPosition(LendingProtocol.Navi).then(setPosition);
    }
  }, [isConnected, getPosition]);

  if (!position) return <div>No position</div>;

  return (
    <div>
      <p>Collateral: {position.collateral.symbol} ${position.collateral.valueUsd.toFixed(2)}</p>
      <p>Debt: {position.debt.symbol} ${position.debt.valueUsd.toFixed(2)}</p>
      <p>Net Value: ${position.netValueUsd.toFixed(2)}</p>
    </div>
  );
}
```

---

## Dry Run (Simulation)

트랜잭션 실행 전 시뮬레이션:

```tsx
const dryRun = async () => {
  const sdk = await getSDK();

  const tx = new Transaction();
  tx.setSender(account.address);
  tx.setGasBudget(200_000_000);

  await sdk.buildLeverageTransaction(tx, {
    protocol: LendingProtocol.Suilend,
    depositAsset: 'SUI',
    depositAmount: '10',
    multiplier: 1.5,
  });

  // Dry run instead of execute
  const result = await suiClient.dryRunTransactionBlock({
    transactionBlock: await tx.build({ client: suiClient }),
  });

  if (result.effects.status.status === 'success') {
    console.log('Simulation passed!');
  } else {
    console.error('Would fail:', result.effects.status.error);
  }
};
```
