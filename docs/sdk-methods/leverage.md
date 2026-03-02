# `sdk.buildLeverageTransaction()` — Leverage Execution

> **대상 독자**: DefiDash SDK 사용자 및 프론트엔드 개발자
> **목적**: 레버리지 실행 메서드의 사용법, 트랜잭션 흐름, 프로토콜별 차이점 문서화

---

## 개요

`buildLeverageTransaction()`은 레버리지 PTB를 빌드합니다. 실행은 `sdk.execute()` (Node.js) 또는 wallet adapter (Browser)를 사용합니다.

---

## 사용법

### Browser

```typescript
const tx = new Transaction();
tx.setSender(account.address);

await sdk.buildLeverageTransaction(tx, {
  protocol: LendingProtocol.Suilend,
  depositAsset: 'LBTC',
  depositAmount: '0.001',
  multiplier: 2.0,
});

await signAndExecute({ transaction: tx });
```

### Node.js

```typescript
const tx = new Transaction();
tx.setSender(address);

await sdk.buildLeverageTransaction(tx, {
  protocol: LendingProtocol.Suilend,
  depositAsset: 'SUI',
  depositValueUsd: 100,
  multiplier: 2.0,
});

// Dry run (시뮬레이션)
const dryResult = await sdk.dryRun(tx);

// Execute (실행)
const result = await sdk.execute(tx);
console.log(`TX: ${result.txDigest}`);
```

---

## Input: `BrowserLeverageParams`

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `protocol` | O | `LendingProtocol` | 대상 프로토콜 |
| `depositAsset` | O | `string` | 자산 심볼 또는 coin type |
| `depositAmount` | △ | `string` | 토큰 수량 (depositValueUsd와 택 1) |
| `depositValueUsd` | △ | `number` | USD 가치 |
| `multiplier` | O | `number` | 레버리지 배율 (e.g., 2.0) |

> `depositAmount`와 `depositValueUsd` 중 정확히 하나만 제공해야 합니다.

## Output: `StrategyResult` (dryRun / execute)

| 필드 | 타입 | 설명 |
|------|------|------|
| `success` | `boolean` | 성공 여부 |
| `txDigest` | `string?` | 트랜잭션 다이제스트 (실행 시) |
| `gasUsed` | `bigint?` | 가스 사용량 (MIST) |
| `error` | `string?` | 에러 메시지 |

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

- Generic adapter를 통해 PTB 빌드
- Oracle refresh: 프로토콜 어댑터의 `refreshOracles()` 사용
- Navi는 모든 pool oracle을 갱신해야 함 (operated asset뿐 아니라)

### Scallop

- **Scallop SDK builder** 사용 (oracle 업데이트에 `updateAssetPricesQuick` 필요)
- Obligation 관리: 기존 obligation 재사용 또는 새로 생성

---

## Gas 최적화

`sdk.execute()` 호출 시 자동 적용:

1. **Dry run**: 작은 고정 budget으로 시뮬레이션
2. **Gas 계산**: 실제 사용량 + 20% 버퍼
3. **Balance 확인**: 실행 전 잔고 체크
4. **실행**: 최적화된 budget으로 실행

---

## Standalone Function (Advanced)

SDK 클래스 없이 직접 사용:

```typescript
import { buildLeverageTransaction } from '@defidash/sdk';

const tx = new Transaction();
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
```

---

## 에러 처리

| 에러 | 원인 | 해결 |
|------|------|------|
| `InvalidParameterError` | depositAmount/depositValueUsd 문제 | 정확히 하나만 제공 |
| `InvalidParameterError` | multiplier ≤ 1 또는 protocol max 초과 | 유효 범위 확인 |
| `UnknownAssetError` | 미인식 자산 심볼 | COIN_TYPES 확인 |
| `UnsupportedProtocolError` | 미지원 프로토콜 | LendingProtocol enum 확인 |
| `KeypairRequiredError` | `execute()` 시 keypair 미제공 | Browser에서는 wallet adapter 사용 |
| No swap quotes | DEX에서 경로 없음 | 자산/금액 확인 |

---

## 관련 문서

- [Preview Leverage](./preview-leverage.md) — 실행 전 미리보기
- [Find Best Route](./find-best-leverage-route.md) — 프로토콜 자동 비교
- [Deleverage](./deleverage.md) — 레버리지 해제
