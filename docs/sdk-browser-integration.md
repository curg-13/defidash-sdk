# DefiDash SDK - Browser Wallet Integration Guide

## 문제점

현재 SDK의 `initialize()` 메서드는 `Ed25519Keypair`를 필요로 함:

```typescript
await sdk.initialize(suiClient, keypair);  // ❌ Node.js 전용
```

브라우저에서는 `@mysten/dapp-kit`의 wallet adapter를 통해 서명해야 함:

```typescript
const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
await signAndExecute({ transaction: tx });  // ✅ 브라우저 지갑
```

---

## 참고: Suilend SDK 패턴

[Suilend SDK](https://github.com/suilend/suilend-fe-public/blob/main/sdk/src/client.ts)는 **Transaction Builder 패턴**을 사용:

```typescript
// Suilend 방식: Transaction을 인자로 받고, 서명은 외부에서 처리
class SuilendClient {
  deposit(
    sendCoin: TransactionObjectInput,
    coinType: string,
    obligationOwnerCap: TransactionObjectInput,
    transaction: Transaction,  // ← 외부에서 전달받음
  ) {
    // 트랜잭션에 move call 추가만 함
    depositLiquidityAndMintCtokens(transaction, ...);
    depositCtokensIntoObligation(transaction, ...);
    // 실행은 하지 않음!
  }
}

// 프론트엔드에서 사용
const tx = new Transaction();
suilendClient.deposit(coin, "SUI", cap, tx);
await signAndExecute({ transaction: tx });  // 외부에서 서명+실행
```

**핵심**: SDK는 트랜잭션을 **빌드만** 하고, **서명/실행은 호출자가 처리**

---

## 권장 해결방안

### Option A: Transaction Builder 패턴 (Suilend 방식) ⭐ 권장

SDK 메서드가 Transaction 객체를 받아서 PTB를 빌드하고, 실행은 외부에서:

```typescript
// SDK 수정
class DefiDashSDK {
  // 기존: initialize + execute 통합
  // 수정: 빌드와 실행 분리

  buildLeverageTransaction(
    tx: Transaction,
    params: LeverageParams,
  ): Promise<void> {
    // tx에 flash loan, swap, deposit, borrow 추가
    // 서명/실행은 하지 않음
  }

  buildDeleverageTransaction(
    tx: Transaction,
    params: DeleverageParams,
  ): Promise<void> {
    // tx에 deleverage 로직 추가
  }
}

// 프론트엔드 사용
const sdk = new DefiDashSDK();
await sdk.initialize(suiClient, userAddress);  // Keypair 없이 초기화

const tx = new Transaction();
tx.setSender(userAddress);
await sdk.buildLeverageTransaction(tx, { depositAsset: "LBTC", ... });

// 지갑으로 서명+실행
await signAndExecute({ transaction: tx });
```

**장점**:

- SDK는 순수하게 트랜잭션 빌더 역할
- Node.js와 브라우저 모두 지원
- 서명 방식에 독립적

---

### Option B: Signer Interface 패턴

SDK가 signer 인터페이스를 받아서 내부에서 실행:

```typescript
// types.ts
export interface Signer {
  address: string;
  signAndExecuteTransaction(params: {
    transaction: Transaction
  }): Promise<{ digest: string }>;
}

// sdk.ts
class DefiDashSDK {
  private signer?: Signer;
  private keypair?: Ed25519Keypair;

  // Node.js용 (기존)
  initialize(suiClient: SuiClient, keypair: Ed25519Keypair): Promise<void>;

  // 브라우저용 (신규)
  initializeWithSigner(suiClient: SuiClient, signer: Signer): Promise<void> {
    this.suiClient = suiClient;
    this.signer = signer;
    await this.initializeClients();
  }

  private async execute(tx: Transaction) {
    if (this.signer) {
      return this.signer.signAndExecuteTransaction({ transaction: tx });
    } else if (this.keypair) {
      // 기존 keypair 방식
      return this.suiClient.signAndExecuteTransaction({ ... });
    }
  }
}

// 프론트엔드 사용
const account = useCurrentAccount();
const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

const sdk = new DefiDashSDK();
await sdk.initializeWithSigner(suiClient, {
  address: account.address,
  signAndExecuteTransaction: signAndExecute,
});

await sdk.leverage({ ... });  // 내부에서 signer.signAndExecute 호출
```

---

## 권장: Option A (Transaction Builder)

**이유**:

1. Sui 생태계 표준 패턴 (Suilend, Navi 등이 사용)
2. 더 명확한 책임 분리
3. dry run / simulate 지원이 자연스러움
4. 기존 `buildLeverageTransaction`, `buildDeleverageTransaction` export 활용

---

## 구현 체크리스트

### 1. SDK 수정 (`src/sdk.ts`)

```typescript
// 변경 전
initialize(suiClient: SuiClient, keypair: Ed25519Keypair): Promise<void>
leverage(params: LeverageParams): Promise<StrategyResult>

// 변경 후
initialize(suiClient: SuiClient, userAddress?: string): Promise<void>
buildLeverageTransaction(tx: Transaction, params: LeverageParams): Promise<void>
buildDeleverageTransaction(tx: Transaction, params: DeleverageParams): Promise<void>

// 편의 메서드 (Node.js용, 선택적)
executeWithKeypair(tx: Transaction, keypair: Ed25519Keypair): Promise<string>
```

### 2. 기존 호환성 유지

```typescript
// 래퍼 메서드로 기존 API 유지
async leverage(params: LeverageParams & { keypair?: Ed25519Keypair }): Promise<StrategyResult> {
  const tx = new Transaction();
  tx.setSender(this.userAddress);
  await this.buildLeverageTransaction(tx, params);

  if (params.dryRun) {
    return this.dryRun(tx);
  }
  if (params.keypair) {
    return this.executeWithKeypair(tx, params.keypair);
  }
  // 브라우저에서는 tx만 반환하고 외부에서 실행하도록
  throw new Error("Keypair required for execution. Use buildLeverageTransaction for browser.");
}
```

### 3. 프론트엔드 훅 예시

```typescript
// useDefiDashSDK.ts
export function useDefiDashSDK() {
  const account = useCurrentAccount();
  const suiClient = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const leverage = useCallback(async (params: LeverageParams) => {
    const sdk = new DefiDashSDK();
    await sdk.initialize(suiClient, account.address);

    const tx = new Transaction();
    tx.setSender(account.address);
    tx.setGasBudget(200_000_000);

    await sdk.buildLeverageTransaction(tx, params);

    if (params.dryRun) {
      return suiClient.dryRunTransactionBlock({
        transactionBlock: await tx.build({ client: suiClient }),
      });
    }

    return signAndExecute({ transaction: tx });
  }, [account, suiClient, signAndExecute]);

  return { leverage };
}
```

---

## 요약

| 항목   | 현재                          | 권장 수정                              |
| ------ | ----------------------------- | -------------------------------------- |
| 초기화 | `initialize(client, keypair)` | `initialize(client, address?)`         |
| 실행   | SDK 내부에서 서명+실행        | 트랜잭션 빌드만, 외부에서 실행         |
| 메서드 | `leverage(params)`            | `buildLeverageTransaction(tx, params)` |
| 호환성 | Node.js 전용                  | Node.js + 브라우저                     |
