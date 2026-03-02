# Adding a New Lending Protocol

> 새로운 lending 프로토콜 어댑터를 추가하기 위한 가이드.

---

## 빌드 타임 강제

`BaseProtocolAdapter`는 `ILendingProtocol` 인터페이스를 **완전히** 구현합니다 (`Partial` 아님).
새 어댑터가 필수 메서드를 빠뜨리면 `tsc`가 빌드 에러를 발생시킵니다:

```
error TS2515: Non-abstract class 'NewAdapter' does not implement
  inherited abstract member 'deposit' from class 'BaseProtocolAdapter'.
```

Go의 인터페이스 준수 패턴과 동일한 효과:

```go
// Go: 컴파일 타임에 인터페이스 구현 강제
var _ ILendingProtocol = (*NewAdapter)(nil)
```

```typescript
// TypeScript: abstract class가 동일한 역할
export class NewAdapter extends BaseProtocolAdapter {
  // 필수 메서드 누락 시 → 빌드 에러
}
```

---

## 구현 체크리스트

### 1. 어댑터 파일 생성

```
src/protocols/new-protocol/
  adapter.ts       ← BaseProtocolAdapter 확장
  constants.ts     ← 프로토콜별 상수 (coin type 매핑 등)
  calculators.ts   ← 프로토콜별 계산 로직 (optional)
```

### 2. BaseProtocolAdapter 확장

```typescript
import { BaseProtocolAdapter } from "../base-adapter";

export class NewProtocolAdapter extends BaseProtocolAdapter {
  readonly name = "new-protocol";
  readonly consumesRepaymentCoin = false; // true if repay() consumes entire coin
```

### 3. 필수 메서드 구현

| 메서드 | 용도 | 비고 |
|--------|------|------|
| `initialize(suiClient)` | 프로토콜 SDK 초기화 | `await super.initialize(suiClient)` 호출 필수 |
| `getPosition(userAddress)` | 유저 포지션 조회 | `PositionInfo` 반환 (supplies[], borrows[] 포함) |
| `deposit(tx, coin, coinType, userAddress)` | 담보 예치 PTB 명령 추가 | |
| `withdraw(tx, coinType, amount, userAddress)` | 담보 인출 PTB 명령 추가 | coin 객체 반환 |
| `borrow(tx, coinType, amount, userAddress)` | 차입 PTB 명령 추가 | coin 객체 반환 |
| `repay(tx, coinType, coin, userAddress)` | 상환 PTB 명령 추가 | |
| `refreshOracles(tx, coinTypes, userAddress)` | 오라클 가격 갱신 PTB 명령 | |
| `getAccountPortfolio(address)` | 대시보드용 포트폴리오 | APY 데이터 포함 |
| `getAssetRiskParams(coinType)` | LTV, 청산 임계값 | `maxMultiplier` 계산 포함 |
| `getAssetApy(coinType)` | Supply/Borrow APY | 리워드 APY 포함 |

### 4. 선택적 메서드

| 메서드 | 용도 | 기본값 |
|--------|------|--------|
| `clearPendingState()` | TX 간 상태 초기화 | no-op |

---

## 제약사항

### Flash Loan

- Flash loan은 **항상 Scallop**에서 제공됨 (프로토콜 어댑터에서 구현하지 않음)
- 새 프로토콜은 Scallop flash loan으로 빌린 USDC를 사용/상환하는 PTB 흐름만 구현

### Oracle

- `refreshOracles()`는 레버리지/디레버리지 PTB 내에서 7k swap **이전에** 호출됨
- Pyth oracle hot potato 충돌을 방지하기 위함
- 프로토콜이 관련 없는 풀의 oracle도 갱신해야 할 수 있음 (Navi 사례)

### Repayment Coin 소비

```typescript
readonly consumesRepaymentCoin = false;
```

| 값 | 의미 | 프로토콜 |
|----|------|----------|
| `false` | `repay()`가 unused portion을 coin에 남김 | Suilend, Scallop |
| `true` | `repay()`가 coin 전체를 소비 | Navi |

이 플래그에 따라 디레버리지 로직이 `splitCoins` 전략을 다르게 적용합니다.

### PositionInfo 구조

`getPosition()` 반환값은 반드시 다음을 포함:

```typescript
{
  collateral: AssetPosition,  // USD 가치 최대 supply
  debt: AssetPosition,        // USD 가치 최대 borrow
  supplies: AssetPosition[],  // 전체 supply 목록
  borrows: AssetPosition[],   // 전체 borrow 목록
  netValueUsd: number,        // 총 supply USD - 총 borrow USD
}
```

- `collateral`/`debt`는 `supplies`/`borrows` 중 가장 큰 항목 자동 선택
- 포지션이 없으면 `null` 반환

---

## SDK 등록

`src/sdk.ts`의 `initialize()`에 어댑터 추가:

```typescript
const newProtocol = new NewProtocolAdapter();
await newProtocol.initialize(suiClient);
this.protocols.set(LendingProtocol.NewProtocol, newProtocol);
```

`src/types/common.ts`의 enum에 추가:

```typescript
export enum LendingProtocol {
  Suilend = "suilend",
  Navi = "navi",
  Scallop = "scallop",
  NewProtocol = "new-protocol",  // 추가
}
```

---

## 테스트 추가

| 테스트 파일 | 테스트 내용 |
|-------------|------------|
| `internal.getPosition.test.ts` | 어댑터 레벨 포지션 조회 |
| `internal.getAssetRiskParams.test.ts` | LTV, maxMultiplier 검증 |
| `internal.getAssetApy.test.ts` | Supply/Borrow APY 검증 |
| `sdk.leverage.test.ts` | `buildLeverageTransaction` + `dryRun` |
| `sdk.deleverage.test.ts` | `buildDeleverageTransaction` + `dryRun` |

각 테스트에 새 프로토콜 케이스를 `it.each`에 추가합니다.

---

## 참고: 기존 어댑터 구조

```
src/protocols/
  base-adapter.ts          ← abstract class (ILendingProtocol 전체 강제)
  suilend/
    adapter.ts             ← implements ILendingProtocol 직접
    constants.ts
    calculators.ts
  navi/
    adapter.ts             ← implements ILendingProtocol 직접
    constants.ts
  scallop/
    adapter.ts             ← implements ILendingProtocol 직접
    flash-loan.ts          ← ScallopFlashLoanClient (flash loan 전용)
    constants.ts
```

> 기존 3개 어댑터는 `BaseProtocolAdapter`를 extend하지 않고 `ILendingProtocol`을 직접 구현합니다.
> 새 프로토콜은 `BaseProtocolAdapter`를 extend하는 것을 권장합니다 (공통 유틸리티 재사용).
> 두 방식 모두 빌드 타임에 메서드 구현을 강제합니다.
