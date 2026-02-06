# Gas Cost Analysis: Suilend vs Scallop

## 개요

Leverage 전략 실행 시 Suilend와 Scallop 간의 가스 비용 차이를 분석합니다.

**실측 결과:**
- **Suilend**: ~0.04 SUI (39,645,640 MIST)
- **Scallop**: ~0.08 SUI (80,000,000+ MIST)
- **차이**: Scallop이 약 **1.7~2배** 더 비쌈

이 문서는 Move 컨트랙트 레벨에서 왜 이런 차이가 발생하는지 분석합니다.

---

## 핵심 차이 요약

| 항목 | Suilend | Scallop |
|------|---------|---------|
| Oracle 패턴 | Lazy refresh (별도 호출) | Inline refresh (매 작업마다) |
| Collateral 가치 계산 | Refresh된 캐시 사용 | 매번 Oracle 조회 |
| 복잡도 | O(1) per operation | O(n+m) per operation |
| Oracle 시스템 | Pyth 직접 사용 | xOracle 추상화 레이어 |

---

## 1. Oracle 아키텍처 비교

### Suilend: Lazy Oracle Pattern

Suilend는 **"refresh-then-use"** 패턴을 사용합니다. Oracle 가격 업데이트가 실제 작업과 분리되어 있습니다.

```
contracts/suilend/sources/lending_market.move
```

```move
/// 가격 업데이트 - 별도 함수로 분리
public fun refresh_reserve_price<P>(
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
    clock: &Clock,
    price_info_object: &PriceInfoObject,
) {
    let reserve = vector::borrow_mut(&mut lending_market.reserves, reserve_array_index);
    reserve::update_price<P>(reserve, clock, price_info_object);
}
```

**장점:**
1. 가격 업데이트를 한 번만 수행
2. 이후 작업들은 캐시된 가격 사용
3. PTB 내에서 효율적인 배치 처리 가능

### Scallop: Inline Oracle Pattern

Scallop은 **매 작업마다** xOracle을 통해 가격을 조회합니다.

```
contracts/scallop/money-market/sources/borrow.move
```

```move
public fun borrow<CoinType>(
    version: &Version,
    obligation: &mut Obligation,
    obligation_key: &ObligationKey,
    market: &mut Market,
    coin_decimals_registry: &CoinDecimalsRegistry,
    borrow_amount: u64,
    x_oracle: &XOracle,  // ← 매번 Oracle 전달 필요
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<CoinType> {
    // ...
    // 모든 collateral에 대해 가격 조회
    let collateral_value = collateral_value::collaterals_value_usd_for_borrow(...);
    // 모든 debt에 대해 가격 조회
    let debt_value = debt_value::debts_value_usd_for_borrow(...);
    // ...
}
```

---

## 2. Collateral/Debt 가치 계산 차이

### Suilend: O(1) 조회

Suilend는 obligation 구조체 내에 **캐시된 가치**를 저장합니다.

```
contracts/suilend/sources/obligation.move
```

```move
struct Obligation<phantom P> has key, store {
    id: UID,
    lending_market_id: ID,
    deposits: vector<Deposit>,
    borrows: vector<Borrow>,

    // ✅ 캐시된 USD 가치 (미리 계산됨)
    deposited_value_usd: Decimal,
    allowed_borrow_value_usd: Decimal,
    unhealthy_borrow_value_usd: Decimal,
    super_unhealthy_borrow_value_usd: Decimal,
    unweighted_borrowed_value_usd: Decimal,
    weighted_borrowed_value_usd: Decimal,
    weighted_borrowed_value_upper_bound_usd: Decimal,
}
```

```move
/// Health check - 캐시된 값 사용
public fun is_healthy<P>(obligation: &Obligation<P>): bool {
    // 단순 비교 - Oracle 호출 없음!
    decimal::le(
        obligation.weighted_borrowed_value_usd,
        obligation.unhealthy_borrow_value_usd
    )
}
```

### Scallop: O(n+m) 조회

Scallop은 **매번 모든 collateral과 debt를 순회**하며 가격을 조회합니다.

```
contracts/scallop/money-market/sources/collateral_value.move
```

```move
/// 모든 collateral 순회 - O(n) 복잡도
public fun collaterals_value_usd_for_borrow(
    obligation: &Obligation,
    market: &Market,
    coin_decimals_registry: &CoinDecimalsRegistry,
    x_oracle: &XOracle,
    clock: &Clock,
): u64 {
    let collaterals = obligation::collaterals(obligation);
    let value = 0;
    let (i, n) = (0, vector::length(collaterals));

    // ⚠️ 모든 collateral에 대해 반복
    while (i < n) {
        let collateral = vector::borrow(collaterals, i);
        let collateral_type = collateral::type_name(collateral);

        // ⚠️ 각 collateral마다 Oracle 가격 조회
        let (price, _) = price::get_price(x_oracle, collateral_type, clock);

        // ... 가치 계산
        i = i + 1;
    };

    value
}
```

```
contracts/scallop/money-market/sources/debt_value.move
```

```move
/// 모든 debt 순회 - O(m) 복잡도
public fun debts_value_usd_for_borrow(
    obligation: &Obligation,
    market: &Market,
    coin_decimals_registry: &CoinDecimalsRegistry,
    x_oracle: &XOracle,
    clock: &Clock,
): u64 {
    let debts = obligation::debts(obligation);
    let value = 0;
    let (i, n) = (0, vector::length(debts));

    // ⚠️ 모든 debt에 대해 반복
    while (i < n) {
        let debt = vector::borrow(debts, i);
        let debt_type = debt::type_name(debt);

        // ⚠️ 각 debt마다 Oracle 가격 조회
        let (price, _) = price::get_price(x_oracle, debt_type, clock);

        // ... 가치 계산
        i = i + 1;
    };

    value
}
```

---

## 3. Oracle 시스템 복잡도

### Suilend: Pyth 직접 사용

```
contracts/suilend/sources/reserve.move
```

```move
public(package) fun update_price<P>(
    reserve: &mut Reserve<P>,
    clock: &Clock,
    pyth_price_info: &PriceInfoObject,
) {
    // Pyth에서 직접 가격 가져오기
    let price = pyth::get_price(pyth_price_info, clock);
    // ... 캐시에 저장
}
```

### Scallop: xOracle 추상화 레이어

Scallop은 xOracle이라는 추가 추상화 레이어를 사용합니다.

```
sdk/src/builders/oracles/index.ts (참고용 - TypeScript SDK)
```

```typescript
// xOracle은 여러 Oracle 소스를 조합
const updatePrice = (
    txBlock,
    rules: xOracleRules,  // primary + secondary rules
    // ...
) => {
    // 1. 가격 업데이트 요청 생성
    const request = priceUpdateRequest(txBlock, ...);

    // 2. 각 Oracle 소스별 업데이트
    if (rule.includes('pyth')) {
        updatePythPrice(type, txBlock, ...);
    }
    if (rule.includes('supra')) {
        updateSupraPrice(type, txBlock, ...);
    }
    if (rule.includes('switchboard')) {
        updateSwitchboardPrice(type, txBlock, ...);
    }

    // 3. 요청 확인
    confirmPriceUpdateRequest(txBlock, ...);
}
```

**xOracle 오버헤드:**
1. 가격 업데이트 요청 생성 (1 Move call)
2. Primary Oracle 업데이트 (1+ Move calls)
3. Secondary Oracle 업데이트 (1+ Move calls)
4. 요청 확인 (1 Move call)

→ 단일 자산 가격 업데이트에 **4+ Move calls** 필요

---

## 4. Borrow 함수 비교

### Suilend borrow

```
contracts/suilend/sources/lending_market.move
```

```move
public fun borrow<P, T>(
    lending_market: &mut LendingMarket<P>,
    reserve_array_index: u64,
    obligation_owner_cap: &ObligationOwnerCap<P>,
    clock: &Clock,
    amount: u64,
    ctx: &mut TxContext
): Coin<T> {
    // 1. Obligation 가져오기
    let obligation = object_bag::borrow_mut(...);

    // 2. Health check (캐시된 값 사용 - O(1))
    assert!(obligation::is_healthy(obligation), EObligationIsNotHealthy);

    // 3. Reserve에서 borrow
    let coin = reserve::borrow(reserve, obligation, clock, amount, ctx);

    // 4. Obligation 업데이트 (값 재계산)
    obligation::refresh(obligation, &lending_market.reserves, clock);

    coin
}
```

### Scallop borrow

```
contracts/scallop/money-market/sources/borrow.move
```

```move
public fun borrow<CoinType>(
    version: &Version,
    obligation: &mut Obligation,
    obligation_key: &ObligationKey,
    market: &mut Market,
    coin_decimals_registry: &CoinDecimalsRegistry,
    borrow_amount: u64,
    x_oracle: &XOracle,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<CoinType> {
    // 1. Version check
    version::assert_current_version(version);

    // 2. 모든 Collateral 가치 계산 - O(n) Oracle calls!
    let collateral_value = collateral_value::collaterals_value_usd_for_borrow(
        obligation, market, coin_decimals_registry, x_oracle, clock
    );

    // 3. 모든 Debt 가치 계산 - O(m) Oracle calls!
    let debt_value = debt_value::debts_value_usd_for_borrow(
        obligation, market, coin_decimals_registry, x_oracle, clock
    );

    // 4. Health check
    assert!(collateral_value > debt_value, EBorrowTooMuch);

    // 5. 실제 borrow 수행
    // ...
}
```

---

## 5. 가스 비용 분석

### Leverage 시나리오 (1 collateral + 1 debt)

| 단계 | Suilend Calls | Scallop Calls |
|------|---------------|---------------|
| Flash loan | 1 | 1 |
| Swap | 1 | 1 |
| Oracle refresh | 2 (deposit + borrow asset) | 8+ (xOracle 4 calls × 2 assets) |
| Deposit | 1 | 1 |
| Borrow | 1 (캐시 사용) | 1 + 2 inline oracle (collateral + debt) |
| Repay flash loan | 1 | 1 |
| **Total** | **~7** | **~15+** |

### Collateral/Debt가 증가할 때

| 포지션 크기 | Suilend | Scallop |
|-------------|---------|---------|
| 1 collateral, 1 debt | ~7 calls | ~15 calls |
| 2 collateral, 1 debt | ~8 calls | ~19 calls |
| 3 collateral, 2 debt | ~10 calls | ~27 calls |

Scallop의 경우 `O(n+m)` 복잡도로 인해 포지션이 복잡해질수록 가스 비용이 급격히 증가합니다.

---

## 6. SDK 레벨 차이

### Suilend SDK

```typescript
// Oracle refresh를 별도로 호출
await suilendClient.refreshAll(tx, obligation, [depositCoinType, borrowCoinType]);

// 이후 작업들은 캐시된 가격 사용
suilendClient.deposit(coin, coinType, cap, tx);
await suilendClient.borrow(cap, obligationId, coinType, amount, tx,
    false  // addRefreshCalls = false (이미 refresh 완료)
);
```

### Scallop SDK

```typescript
// Scallop은 자체 builder 사용 필요
const scallopBuilder = await scallopClient.createTxBuilder();
const tx = scallopBuilder.createTxBlock();

// updateAssetPricesQuick은 내부적으로 xOracle 업데이트
await tx.updateAssetPricesQuick(['lbtc', 'usdc']);

// 각 작업마다 내부적으로 추가 Oracle 조회 발생
await tx.borrowQuick(amount, 'usdc');
```

---

## 7. 결론 및 권장사항

### 왜 Scallop이 더 비싼가?

1. **xOracle 추상화 오버헤드**: 단일 가격 조회에 여러 Move call 필요
2. **Inline Oracle 패턴**: 캐시 없이 매번 Oracle 조회
3. **O(n+m) 복잡도**: 모든 collateral/debt 순회하며 가격 조회
4. **다중 Oracle 소스**: Pyth + Switchboard + Supra 지원을 위한 오버헤드

### 프로토콜 선택 가이드

| 상황 | 권장 프로토콜 |
|------|--------------|
| 가스 비용 민감 | Suilend |
| 단순 포지션 (1-2 자산) | 둘 다 OK |
| 복잡한 포지션 (3+ 자산) | Suilend |
| 다양한 Oracle 필요 | Scallop |

### 최적화 팁

**Suilend:**
- `refreshAll`을 deposit 전에 한 번만 호출
- `borrow` 시 `addRefreshCalls=false` 사용

**Scallop:**
- `updateAssetPricesQuick`으로 필요한 자산만 업데이트
- Scallop SDK builder 사용 (자체 최적화 포함)

---

## 참고 자료

- [Suilend Contract](https://github.com/suilend/suilend-public)
- [Scallop Contract](https://github.com/scallop-io/scallop-contract)
- [Suilend SDK](https://github.com/suilend/suilend-fe-public)
- [Scallop SDK](https://github.com/scallop-io/scallop-sdk)
