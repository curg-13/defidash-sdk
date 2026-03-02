# `sdk.buildDeleverageTransaction()` — Deleverage Execution

> **대상 독자**: DefiDash SDK 사용자 및 프론트엔드 개발자
> **목적**: 디레버리지(포지션 해제) 메서드의 사용법, estimate 로직, 트랜잭션 흐름 문서화

---

## 개요

디레버리지는 레버리지 포지션을 **원자적으로 해제**합니다:
1. Flash loan으로 부채 상환
2. 담보 전체 인출
3. 담보 일부를 USDC로 스왑하여 flash loan 상환
4. 나머지 담보 + USDC 잔액을 유저에게 반환

---

## 사용법

### Browser

```typescript
const tx = new Transaction();
tx.setSender(account.address);

await sdk.buildDeleverageTransaction(tx, {
  protocol: LendingProtocol.Suilend,
});

await signAndExecute({ transaction: tx });
```

### Node.js

```typescript
const tx = new Transaction();
tx.setSender(address);

await sdk.buildDeleverageTransaction(tx, {
  protocol: LendingProtocol.Suilend,
});

// Dry run (시뮬레이션)
const dryResult = await sdk.dryRun(tx);

// Execute (실행)
const result = await sdk.execute(tx);
console.log(`Position closed: ${result.txDigest}`);
```

---

## Input: `BrowserDeleverageParams`

| 파라미터 | 필수 | 타입 | 설명 |
|----------|------|------|------|
| `protocol` | O | `LendingProtocol` | 포지션이 있는 프로토콜 |

## Output: `StrategyResult` (dryRun / execute)

| 필드 | 타입 | 설명 |
|------|------|------|
| `success` | `boolean` | 성공 여부 |
| `txDigest` | `string?` | 트랜잭션 다이제스트 (실행 시) |
| `gasUsed` | `bigint?` | 가스 사용량 (MIST) |
| `error` | `string?` | 에러 메시지 |

---

## Estimate 로직: `calculateDeleverageEstimate()`

디레버리지 트랜잭션 빌드 시 내부적으로 호출되는 estimate 계산:

```
calculateDeleverageEstimate(params)
  │
  ├── 1. Flash loan amount
  │     └── flashLoanUsdc = debtAmount × 1.001 (0.1% buffer for accrued interest)
  │
  ├── 2. Flash loan fee
  │     └── flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc)
  │
  ├── 3. Total repayment
  │     └── totalRepayment = flashLoanUsdc + flashLoanFee
  │
  ├── 4. Optimal swap amount
  │     ├── Get full-collateral swap quote (collateral → USDC)
  │     ├── targetUsdcOut = totalRepayment × 1.02 (2% buffer)
  │     ├── swapAmount = targetUsdcOut × (fullSwapIn / fullSwapOut)
  │     └── Cap at total collateral if needed
  │
  ├── 5. Keep collateral
  │     └── keepCollateral = withdrawAmount - swapAmount
  │
  └── 6. Profit estimate
        └── totalProfitUsd = keepCollateral value + USDC surplus
```

### `DeleverageEstimate` Output

| 필드 | 타입 | 설명 |
|------|------|------|
| `flashLoanUsdc` | `bigint` | Flash loan 금액 |
| `flashLoanFee` | `bigint` | Flash loan 수수료 |
| `totalRepayment` | `bigint` | 총 상환 금액 |
| `swapAmount` | `bigint` | 스왑할 담보 금액 |
| `keepCollateral` | `bigint` | 유저가 보유할 담보 |
| `estimatedUsdcProfit` | `bigint` | 예상 USDC 이익 |
| `totalProfitUsd` | `number` | 총 예상 이익 (USD) |

---

## 트랜잭션 흐름 (PTB)

### Generic (Suilend, Navi)

```
1. Flash Loan USDC
2. Refresh Oracles
3. Repay Debt (flash loan USDC 사용)
4. Withdraw ALL Collateral
5. Swap Partial Collateral → USDC (flash loan 상환용)
6. Repay Flash Loan
7. Transfer Remaining to User
   ├── 남은 담보 (collateral)
   ├── 남은 USDC (swap 잔액)
   └── (일부 프로토콜) loan coin 잔액
```

### Scallop (Direct MoveCall)

```
0. Unstake Obligation (if locked)
1. Flash Loan USDC
2. Repay Debt (direct moveCall: repay::repay)
3. Withdraw Collateral (direct moveCall: withdraw_collateral)
4. Swap Partial Collateral → USDC
5. Repay Flash Loan
6. Transfer Remaining to User
```

> Scallop은 obligation unstaking이 필요할 수 있으며,
> 프로토콜 주소를 직접 사용하는 moveCall 패턴을 사용합니다.

---

## Standalone Function (Advanced)

```typescript
import {
  buildDeleverageTransaction,
  calculateDeleverageEstimate,
} from '@defidash/sdk';

// Estimate only
const estimate = await calculateDeleverageEstimate({
  protocol: suilendAdapter,
  flashLoanClient,
  swapClient,
  suiClient,
  userAddress,
  position: currentPosition,
});

console.log(`Keep: ${estimate.keepCollateral} tokens`);
console.log(`Profit: $${estimate.totalProfitUsd.toFixed(2)}`);

// Build TX
const tx = new Transaction();
await buildDeleverageTransaction(tx, params);
```

---

## 에러 처리

| 에러 | 원인 | 해결 |
|------|------|------|
| `PositionNotFoundError` | 해당 프로토콜에 포지션 없음 | `getPosition()` 으로 확인 |
| `NoDebtError` | 부채 없는 포지션 | withdraw 사용 |
| `KeypairRequiredError` | `execute()` 시 keypair 미제공 | Browser에서는 wallet adapter 사용 |
| No swap quotes | DEX에서 경로 없음 | 자산/금액 확인 |
| Zero swap output | 스왑 출력 0 (유동성 부족) | 자산/금액 확인 |

---

## 관련 문서

- [Leverage](./leverage.md) — 레버리지 실행
- [Preview Leverage](./preview-leverage.md) — 실행 전 미리보기
- [Find Best Route](./find-best-leverage-route.md) — 프로토콜 자동 비교
