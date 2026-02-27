# `sdk.leverage()` / `sdk.buildLeverageTransaction()` — Leverage Execution

> **대상 독자**: DefiDash SDK 사용자 및 프론트엔드 개발자
> **목적**: 레버리지 실행 메서드들의 사용법, 트랜잭션 흐름, 프로토콜별 차이점 문서화

---

## 개요

레버리지 전략을 실행하는 두 가지 방법이 있습니다:

| 메서드 | 환경 | 설명 |
|--------|------|------|
| `sdk.leverage()` | Node.js | Keypair로 서명+실행까지 자동 처리 |
| `sdk.buildLeverageTransaction()` | Browser | TX 빌드만 수행, wallet adapter로 서명 |

---

## Node.js: `sdk.leverage()`

```typescript
const result = await sdk.leverage({
  protocol: LendingProtocol.Suilend,
  depositAsset: 'SUI',
  depositAmount: '10',       // 10 SUI
  multiplier: 2.0,
  dryRun: true,              // true: 시뮬레이션만, false: 실행
});

if (result.success) {
  console.log(`TX: ${result.txDigest}`);
  console.log(`Gas: ${result.gasUsed}`);
}
```

### Input: `LeverageParams`

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `protocol` | O | `LendingProtocol` | 대상 프로토콜 |
| `depositAsset` | O | `string` | 자산 심볼 또는 coin type |
| `depositAmount` | △ | `string` | 토큰 수량 (depositValueUsd와 택 1) |
| `depositValueUsd` | △ | `number` | USD 가치 |
| `multiplier` | O | `number` | 레버리지 배율 (e.g., 2.0) |
| `dryRun` | - | `boolean` | true면 시뮬레이션만 |

### Output: `StrategyResult`

| 필드 | 타입 | 설명 |
|------|------|------|
| `success` | `boolean` | 성공 여부 |
| `txDigest` | `string?` | 트랜잭션 다이제스트 (실행 시) |
| `gasUsed` | `bigint?` | 가스 사용량 (MIST) |
| `error` | `string?` | 에러 메시지 |

---

## Browser: `sdk.buildLeverageTransaction()`

```typescript
const tx = new Transaction();
tx.setSender(account.address);
tx.setGasBudget(200_000_000);

await sdk.buildLeverageTransaction(tx, {
  protocol: LendingProtocol.Suilend,
  depositAsset: 'LBTC',
  depositAmount: '0.001',
  multiplier: 2.0,
});

// Wallet adapter로 서명 & 실행
await signAndExecute({ transaction: tx });
```

### Input: `BrowserLeverageParams`

`LeverageParams`와 동일하되 `dryRun` 필드 없음.

---

## 트랜잭션 흐름 (PTB)

모든 단계가 하나의 Programmable Transaction Block으로 원자적(atomic) 실행됩니다:

```
1. Flash Loan USDC (Scallop)
   └── USDC 차입 (flashLoanUsdc = equity × (multiplier - 1))

2. Swap USDC → Deposit Asset (7k Protocol)
   └── DEX aggregator를 통한 최적 경로 스왑

3. Merge Coins
   └── 유저 예치금 + 스왑 결과 병합

4. Refresh Oracles
   └── 프로토콜별 가격 오라클 업데이트

5. Deposit Collateral
   └── 전체 금액을 lending protocol에 예치

6. Borrow USDC
   └── Flash loan 상환을 위한 USDC 차입

7. Repay Flash Loan
   └── 차입 USDC로 flash loan 상환 (초과분은 유저에게 반환)
```

> **Flash loan은 반드시 같은 트랜잭션 내에서 상환해야 합니다.** 미상환 시 전체 TX 실패.

---

## 프로토콜별 차이점

### Suilend / Navi

- `buildLeverageTransaction()` → generic adapter를 통해 PTB 빌드
- Oracle refresh: 프로토콜 어댑터의 `refreshOracles()` 사용

### Scallop

- `sdk.leverage()`에서 내부적으로 `buildScallopLeverageTransaction()` 호출
- **Scallop SDK builder** 사용 (oracle 업데이트에 `updateAssetPricesQuick` 필요)
- `secretKey` 옵션 필수 (Scallop SDK 초기화에 사용)
- Obligation 관리: 기존 obligation 재사용 또는 새로 생성

```typescript
const sdk = new DefiDashSDK({ secretKey: 'suiprivkey...' });
```

---

## Gas 최적화

1. **Dry run**: 작은 고정 budget으로 시뮬레이션
2. **Gas 계산**: 실제 사용량 + 20% 버퍼
3. **Balance 확인**: 실행 전 잔고 체크
4. **실행**: 최적화된 budget으로 실행

---

## Standalone Functions (Advanced)

SDK 클래스 없이 직접 사용:

```typescript
import {
  buildLeverageTransaction,
  buildScallopLeverageTransaction,
} from '@defidash/sdk';

// Generic (Suilend, Navi)
await buildLeverageTransaction(tx, {
  protocol: suilendAdapter,
  flashLoanClient,
  swapClient,
  suiClient,
  userAddress,
  depositCoinType: '0x2::sui::SUI',
  depositAmount: 1000000000n,
  multiplier: 2.0,
});

// Scallop-specific
const { tx, builder } = await buildScallopLeverageTransaction(
  { coinType, depositAmount: '10', multiplier: 2.0, userAddress, secretKey },
  { suiClient, swapClient },
);
```

---

## 에러 처리

| 에러 | 원인 | 해결 |
|------|------|------|
| `KeypairRequiredError` | `leverage()` 호출 시 keypair 미제공 | `buildLeverageTransaction` 사용 |
| `InvalidParameterError` | depositAmount/depositValueUsd 문제 | 하나만 제공 |
| `UnknownAssetError` | 미인식 자산 심볼 | COIN_TYPES 확인 |
| `UnsupportedProtocolError` | 프로토콜 미초기화 | `initialize()` 호출 |
| No swap quotes | DEX에서 경로 없음 | 자산/금액 확인 |
| Dry run failed | TX 시뮬레이션 실패 | 에러 메시지 확인 |

---

## 관련 문서

- [Preview Leverage](./preview-leverage.md) — 실행 전 미리보기
- [Find Best Route](./find-best-leverage-route.md) — 프로토콜 자동 비교
- [Deleverage](./deleverage.md) — 레버리지 해제
