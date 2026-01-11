# Suilend Oracle Refresh 로직 이해하기

## 개요

Suilend에서 deposit/borrow 작업을 수행할 때, **Oracle Price Staleness** 문제로 인해 `assert_no_stale_oracles` 에러가 발생할 수 있습니다. 이 문서는 왜 이런 문제가 발생하는지, 그리고 어떻게 해결하는지를 상세히 설명합니다.

## 참고 자료

- [Suilend SDK Client 소스코드](https://github.com/suilend/suilend-fe-public/blob/main/sdk/src/client.ts)
- [Suilend SDK 공식 문서](https://docs.suilend.fi/ecosystem/suilend-sdk-guide/getting-started-with-suilend-sdk)

---

## 문제: `assert_no_stale_oracles` 에러

### 에러 메시지

```
MoveAbort(MoveLocation {
  module: ModuleId {
    address: 2d2a5129b8f07061d697c1b1729a06e696bf3b19c865a869055efba83759b04b,
    name: Identifier("obligation")
  },
  function: 37,
  instruction: 5,
  function_name: Some("assert_no_stale_oracles")
}, 9)
```

### 원인

Suilend는 Pyth Network의 가격 오라클을 사용합니다. borrow/withdraw 같은 작업을 수행하기 전에, **모든 관련 reserve의 가격 데이터가 최신 상태**여야 합니다. 가격이 오래되면(stale) 트랜잭션이 거부됩니다.

---

## Suilend SDK의 `refreshAll` 함수 분석

SDK 소스코드를 보면 `refreshAll` 함수가 어떻게 동작하는지 이해할 수 있습니다:

```typescript
async refreshAll(
  transaction: Transaction,
  obligation?: Obligation<string>,
  coinTypes?: string[],
) {
  const reserveArrayIndexToPriceId = new Map<bigint, string>();

  // 1. obligation의 기존 deposits에서 reserve 수집
  if (obligation) {
    obligation.deposits.forEach((deposit) => {
      const reserve = this.lendingMarket.reserves[Number(deposit.reserveArrayIndex)];
      reserveArrayIndexToPriceId.set(
        deposit.reserveArrayIndex,
        toHEX(new Uint8Array(reserve.priceIdentifier.bytes)),
      );
    });

    // 2. obligation의 기존 borrows에서 reserve 수집
    obligation.borrows.forEach((borrow) => {
      const reserve = this.lendingMarket.reserves[Number(borrow.reserveArrayIndex)];
      reserveArrayIndexToPriceId.set(
        borrow.reserveArrayIndex,
        toHEX(new Uint8Array(reserve.priceIdentifier.bytes)),
      );
    });
  }

  // 3. 추가 coinTypes가 있으면 해당 reserve도 추가
  if (coinTypes !== undefined) {
    for (const coinType of coinTypes) {
      const reserveArrayIndex = this.findReserveArrayIndex(coinType);
      // ... reserve 추가
    }
  }

  // 4. 수집된 모든 reserve의 가격 refresh
  // ...
}
```

### 핵심 포인트

1. **`obligation` 인자**: 현재 on-chain에서 조회한 obligation 상태
2. **`coinTypes` 인자**: 추가로 refresh할 coin types (optional)
3. obligation의 **기존 deposits + borrows**에 해당하는 reserve들의 가격을 refresh

---

## `borrow` 함수의 내부 동작

```typescript
async borrow(
  obligationOwnerCap: TransactionObjectInput,
  obligationId: string,
  coinType: string,
  value: string,
  transaction: Transaction,
  addRefreshCalls: boolean = true,  // 기본값: true
) {
  if (addRefreshCalls) {
    // ⚠️ 중요: on-chain에서 현재 obligation 상태를 조회
    const obligation = await this.getObligation(obligationId);
    if (!obligation) throw new Error("Error: no obligation");

    // coinType(borrow할 토큰)도 refresh 대상에 추가
    await this.refreshAll(transaction, obligation, [coinType]);
  }

  // borrow 로직 실행...
}
```

---

## PTB(Programmable Transaction Block)에서의 문제

### 시나리오: Flash Loan → Swap → Deposit → Borrow

```
┌─────────────────────────────────────────────────────────────────┐
│                    Single PTB (Atomic Transaction)               │
├─────────────────────────────────────────────────────────────────┤
│  1. Flash Loan USDC                                             │
│  2. Swap USDC → LBTC                                            │
│  3. Deposit LBTC (PTB 내에서만 존재, on-chain 미반영)           │
│  4. Borrow USDC ← ❌ 여기서 문제 발생!                          │
│  5. Repay Flash Loan                                            │
└─────────────────────────────────────────────────────────────────┘
```

### 문제 상세

Step 4에서 `borrow`를 호출할 때:

1. `addRefreshCalls=true`면 SDK가 내부적으로 `await this.getObligation(obligationId)` 호출
2. 이 시점에 **on-chain에는 Step 3의 deposit이 아직 반영되지 않음** (PTB는 아직 실행 전)
3. 따라서 `obligation.deposits`에는 **새로 deposit한 LBTC가 없음**
4. `refreshAll`이 LBTC reserve의 oracle을 refresh하지 않음
5. borrow 시 LBTC oracle이 stale 상태 → **`assert_no_stale_oracles` 에러**

### 시각화

```
On-chain State (조회 시점)     PTB 내부 상태 (실행 예정)
┌────────────────────────┐    ┌────────────────────────┐
│ Obligation:            │    │ Obligation:            │
│   deposits: [기존 것들] │    │   deposits: [기존 + LBTC]│
│   borrows: [기존 것들]  │    │   borrows: [기존 + USDC] │
└────────────────────────┘    └────────────────────────┘
         ↑                              ↑
  getObligation()로 조회        실제로 실행될 상태
  (LBTC deposit 없음!)         (LBTC deposit 있음)
```

---

## 해결책

### 방법 1: 수동으로 `refreshAll` 호출 + coinTypes 명시

**deposit 전에** `refreshAll`을 호출하면서, deposit할 토큰과 borrow할 토큰을 **명시적으로** 포함:

```typescript
// ✅ 올바른 방법: deposit 전에 모든 관련 coin types를 refresh
if (existingCap) {
  const obligation = await SuilendClient.getObligation(
    obligationId,
    [LENDING_MARKET_TYPE],
    suiClient
  );

  // deposit할 토큰(LBTC)과 borrow할 토큰(USDC) 모두 포함!
  await suilendClient.refreshAll(tx, obligation, [
    depositCoinType,  // LBTC
    borrowCoinType,   // USDC
  ]);
}

// 이후 deposit
suilendClient.deposit(coin, depositCoinType, obligationOwnerCapId, tx);

// borrow할 때는 addRefreshCalls=false (이미 위에서 refresh 완료)
await suilendClient.borrow(
  obligationOwnerCapId,
  obligationId,
  borrowCoinType,
  amount,
  tx,
  false  // ⚠️ 중요: 이미 수동으로 refresh 했으므로 false
);
```

### 방법 2: 별도 트랜잭션으로 분리 (비권장)

deposit과 borrow를 별도 트랜잭션으로 분리하면 문제가 없지만, **flash loan 시나리오에서는 불가능**합니다 (flash loan은 같은 트랜잭션 내에서 상환해야 함).

---

## 전체 워크플로우

```
1. Flash Loan USDC
2. Swap USDC → LBTC
3. Merge user's LBTC + swapped LBTC
4. ✅ refreshAll(tx, obligation, [LBTC, USDC])  ← 핵심!
5. Deposit all LBTC as collateral
6. Borrow USDC (addRefreshCalls=false)
7. Repay Flash Loan
```

---

## 체크리스트

Flash Loan leverage 전략 구현 시:

- [ ] `refreshAll`을 **deposit 전에** 호출
- [ ] `refreshAll`에 **deposit할 coinType** 포함
- [ ] `refreshAll`에 **borrow할 coinType** 포함
- [ ] `borrow` 호출 시 `addRefreshCalls=false` 설정

---

## 관련 코드 위치

```
tests/
├── 4_leverage_strategy_dryrun.ts   # Dry run 버전
└── 4_leverage_strategy_exec.ts     # 실행 버전
```

## 참고: 공식 문서의 "Price staleness" 섹션

> **"Price staleness"**
>
> - Call `refreshAll()` to update price feeds
> - Check if Pyth price feeds are working properly

출처: [Suilend SDK Guide - Common Issues](https://docs.suilend.fi/ecosystem/suilend-sdk-guide/getting-started-with-suilend-sdk#price-staleness)
