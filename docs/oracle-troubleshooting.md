# Oracle Troubleshooting Guide

> 프로토콜별 오라클 에러 원인 분석 및 해결 가이드. leverage/deleverage PTB 구성 시 발생하는 오라클 관련 버그를 빠르게 진단하고 수정하기 위한 레퍼런스.

---

## 에러 → 원인 빠른 매핑

| 에러 메시지 | 프로토콜 | 원인 | 해결 섹션 |
|---|---|---|---|
| `dynamic_field::add` abort 0 (command N, N이 swap 이후) | 공통 | Pyth hot potato 충돌 — `refreshOracles`와 7k swap이 같은 Pyth feed를 중복 업데이트 | [#1 Pyth Hot Potato 충돌](#1-pyth-hot-potato-충돌-dynamic_fieldadd-abort-0) |
| `dynamic_field::add` abort 0 (Suilend deleverage) | Suilend | `refreshAll` Map key 타입 불일치 (string vs BigInt) | [#2 Suilend Map Key 불일치](#2-suilend-refreshall-map-key-타입-불일치) |
| `price::get_price` abort 1025 | Scallop | `refreshOracles`가 no-op — xOracle 미갱신 | [#3 Scallop xOracle 미갱신](#3-scallop-xoracle-미갱신) |
| `oracle_pro::update_single_price` abort 0 | Navi | Navi SDK의 oracle config가 on-chain과 불일치 (SDK 버전 문제) | [#4 Navi Oracle Config 불일치](#4-navi-oracle-config-불일치) |
| `assert_no_stale_oracles` abort 9 | Suilend | deposit 전에 refreshAll 미호출, 또는 coinTypes 누락 | [#5 Suilend Stale Oracle](#5-suilend-stale-oracle) |

---

## 프로토콜별 오라클 시스템 개요

```
┌─────────────────────────────────────────────────────────────────┐
│                      Pyth Network (On-chain)                     │
│  - PriceInfoObject per feed                                      │
│  - updatePriceFeeds: create hot potato → update → cleanup        │
│  - hot potato는 PTB 내에서 반드시 생성→소비 lifecycle 완료 필요    │
└───────────┬──────────────────┬──────────────────┬───────────────┘
            │                  │                  │
     ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
     │   Suilend    │   │    Navi     │   │   Scallop   │
     │              │   │             │   │             │
     │ refreshAll() │   │ oracle_pro  │   │  xOracle    │
     │ → Pyth SDK   │   │ ::update_   │   │ → updateAs- │
     │   directly   │   │ single_     │   │ setPrices-   │
     │              │   │ price       │   │ Quick()      │
     │ Pyth 직접    │   │ Pyth+Supra  │   │ Pyth+기타   │
     │ 사용         │   │ 통합 oracle │   │ 통합 oracle │
     └─────────────┘   └─────────────┘   └─────────────┘
```

### 7k Swap과 Pyth의 관계

7k Protocol DEX aggregator는 swap 라우팅 시 일부 DEX(Cetus, Turbos 등)에서 Pyth oracle 업데이트 명령을 PTB에 추가할 수 있음. 이 Pyth 업데이트와 프로토콜의 `refreshOracles`가 같은 price feed를 타겟하면 충돌 발생.

---

## 에러 상세 및 해결

### #1 Pyth Hot Potato 충돌 (`dynamic_field::add` abort 0)

**증상**
```
MoveAbort(MoveLocation { module: ModuleId {
  address: 0x2, name: "dynamic_field"
}, function: 0, instruction: 15, function_name: Some("add") }, 0)
```
- command 번호가 swap 명령 이후 (보통 command 13~25 범위)
- **간헐적 발생** — 7k swap 라우팅에 따라 Pyth 업데이트 포함 여부가 달라짐

**원인**

Pyth on Sui의 `updatePriceFeeds`는 hot potato 패턴 사용:
1. `create_price_infos_hot_potato` → `dynamic_field::add` (필드 생성)
2. `update_single_price_feed` × N (가격 업데이트)
3. `cleanup_price_updates_hot_potato` → `dynamic_field::remove` (필드 제거)

PTB에서 같은 price feed에 대해 이 lifecycle을 **두 번** 실행하면:
- 첫 번째 lifecycle의 cleanup 전에 두 번째 create가 실행되면 → `dynamic_field::add` abort

```
❌ 잘못된 순서 (refreshOracles가 swap 뒤):
  flash_loan → swap (Pyth create→update→cleanup) → refreshOracles (Pyth create → FAIL!)

✅ 올바른 순서 (refreshOracles가 swap 앞):
  flash_loan → refreshOracles (Pyth create→update→cleanup) → swap (Pyth create→update→cleanup)
```

**해결**: `leverage.ts`에서 `refreshOracles`를 swap보다 먼저 호출

```typescript
// src/strategies/leverage.ts

// 1. Flash loan
const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(tx, ...);

// 2. Oracle refresh FIRST (before swap!)
await protocol.refreshOracles(tx, [depositCoinType, USDC_COIN_TYPE], userAddress);

// 3. Swap (7k may add its own Pyth commands — no conflict now)
const swappedAsset = await swapClient.swap({ ... });

// 4~7. Deposit → Borrow → Repay
```

**디버깅 팁**
- command 번호가 swap 관련 범위(5~15)이면 swap 내 Pyth 업데이트 → 프로토콜 Pyth 충돌 의심
- `dynamic_field::add`가 address `0x2`이면 Sui 프레임워크 레벨 — Pyth hot potato 충돌 가능성 높음
- 동일 코드가 **간헐적으로 성공/실패**하면 7k swap 라우팅 차이 (DEX마다 Pyth 필요 여부 다름)

---

### #2 Suilend `refreshAll` Map Key 타입 불일치

**증상**
```
MoveAbort(... "dynamic_field" ... "add" ..., 0)
```
- Suilend deleverage에서 주로 발생
- command 번호가 oracle refresh 구간 (refreshAll이 추가한 명령)

**원인**

Suilend SDK v1.x `refreshAll()`에서 `reserveArrayIndexToPriceId` Map 빌드 시:

```javascript
// obligation entries → STRING key
obligation.deposits.forEach((d) => {
  map.set(d.reserveArrayIndex, ...);  // "3" (string)
});

// coinTypes → BIGINT key
const idx = this.findReserveArrayIndex(ct);
map.set(idx, ...);  // 3n (BigInt)
```

JavaScript Map은 `"3"` ≠ `3n` → 같은 reserve가 Map에 **2번** 등록 → Pyth VAA 중복 제출

**해결**: `SuilendAdapter.refreshOracles()`에서 obligation 내 기존 coinTypes를 필터링

```typescript
// src/protocols/suilend/adapter.ts

const existingCoinTypes = new Set<string>();
obligation.deposits.forEach((d) =>
  existingCoinTypes.add(normalizeCoinType(d.coinType.name))
);
obligation.borrows.forEach((b) =>
  existingCoinTypes.add(normalizeCoinType(b.coinType.name))
);

// obligation에 이미 있는 coinType은 제외 → Map 중복 방지
const newCoinTypes = coinTypes.filter(
  (ct) => !existingCoinTypes.has(normalizeCoinType(ct))
);

await this.client.refreshAll(
  tx,
  obligation,
  newCoinTypes.length > 0 ? newCoinTypes : undefined,
);
```

**근본 원인**: `@suilend/sdk` v1.x의 `parseObligation`이 `reserveArrayIndex`를 string으로 파싱하는 반면, `findReserveArrayIndex`는 BigInt 반환. SDK v2.0에서 수정될 수 있으나, `@7kprotocol/sdk-ts`가 `@mysten/sui` v2.x 미지원이라 업그레이드 불가 (2026-03 기준).

---

### #3 Scallop xOracle 미갱신

**증상**
```
MoveAbort(... "price" ... "get_price" ..., 1025)
```
- Scallop borrow/withdraw 시 발생
- abort code 1025 = 가격 데이터 없음 (oracle 미갱신)

**원인**

`ScallopAdapter.refreshOracles()`가 no-op (빈 함수)이었음. Scallop은 xOracle이라는 자체 oracle 시스템 사용 → Scallop SDK의 `updateAssetPricesQuick()` 호출 필요.

**해결**: Scallop SDK builder를 통해 기존 Transaction에 xOracle 업데이트 주입

```typescript
// src/protocols/scallop/adapter.ts

async refreshOracles(tx: Transaction, coinTypes: string[]): Promise<void> {
  const coinNames = coinTypes
    .map((ct) => this.coinTypeToNameMap[normalizeCoinType(ct)])
    .filter(Boolean);

  if (coinNames.length === 0) return;

  // Scallop builder의 txBlock을 기존 Transaction으로 교체
  const builder = await this.scallop.createScallopBuilder();
  const scallopTx = builder.createTxBlock();
  scallopTx.txBlock = tx;  // 핵심: 기존 tx에 oracle 명령 주입

  await scallopTx.updateAssetPricesQuick(coinNames);
}
```

**핵심 트릭**: `scallopTx.txBlock = tx` — Scallop SDK의 `SuiTxBlock.txBlock` 프로퍼티를 기존 `Transaction`으로 교체하면, `updateAssetPricesQuick()`이 기존 PTB에 oracle 명령을 추가함.

---

### #4 Navi Oracle Config 불일치

**증상**
```
MoveAbort(... "oracle_pro" ... "update_single_price" ..., 0)
```
- command 번호가 oracle refresh 시작 직후 (보통 command 1~3)
- 코드 변경 없이 갑자기 발생하면 SDK 버전 문제

**원인**

Navi의 `oracle_pro::update_single_price` Move 함수 인자:
```
Clock, OracleConfig, PriceOracle, SupraOracleHolder, PythPriceInfoObject, FeedId
```

Navi SDK가 하드코딩하는 `oracleConfig`, `priceOracle`, `supraOracleHolder` 등의 object ID가 on-chain 업그레이드로 변경되면 abort 발생. abort code 0 = 잘못된 oracle config.

**해결**: Navi SDK 업데이트

```bash
npm install @naviprotocol/lending@latest
```

**진단 방법**
```bash
# 현재 버전 확인
node -e "console.log(require('@naviprotocol/lending/package.json').version)"

# 최신 버전 확인
npm view @naviprotocol/lending version

# 버전이 다르면 업데이트
npm install @naviprotocol/lending@<latest>
```

**실제 사례**: v1.3.10 → v1.3.11 업데이트로 `supraOracleHolder` 주소 변경 문제 해결 (2026-03)

---

### #5 Suilend Stale Oracle

**증상**
```
MoveAbort(... "obligation" ... "assert_no_stale_oracles" ..., 9)
```

**원인**

Suilend는 borrow/withdraw 전에 모든 관련 reserve의 Pyth 가격이 최신이어야 함. `refreshAll`이 누락되거나 필요한 coinType이 빠지면 stale oracle 에러.

**해결**: 상세 내용은 [suilend-oracle-refresh.md](./suilend-oracle-refresh.md) 참조.

핵심 체크리스트:
- `refreshAll`을 **deposit 전에** 호출
- deposit할 coinType + borrow할 coinType **모두** 포함
- `borrow()` 호출 시 `addRefreshCalls=false` / `skipOracle=true`

---

## 디버깅 체크리스트

오라클 관련 에러 발생 시:

### Step 1: 에러 식별

- [ ] 에러 메시지에서 **module name** 확인 (`dynamic_field`, `price`, `oracle_pro`, `obligation`)
- [ ] **abort code** 확인 (0, 9, 1025 등)
- [ ] **command 번호** 확인 — 어느 PTB 단계에서 실패했는지 파악

### Step 2: 원인 분류

- [ ] `dynamic_field::add` + address `0x2` → Pyth hot potato 충돌 또는 Map key 불일치
- [ ] `price::get_price` → Scallop xOracle 미갱신
- [ ] `oracle_pro::update_single_price` → Navi SDK config 불일치
- [ ] `assert_no_stale_oracles` → Suilend refreshAll 누락/coinTypes 부족

### Step 3: 간헐적 vs 항상 실패

- [ ] **항상 실패**: 코드 로직 문제 (no-op, 잘못된 인자, SDK 버전)
- [ ] **간헐적 실패**: 7k swap 라우팅 의존 (Pyth hot potato 충돌) — `refreshOracles` 순서 확인

### Step 4: SDK 버전 확인

```bash
node -e "
  const pkgs = ['@naviprotocol/lending', '@suilend/sdk', '@scallop-io/sui-scallop-sdk'];
  pkgs.forEach(p => {
    try { console.log(p + ': ' + require(p + '/package.json').version); }
    catch { console.log(p + ': not installed'); }
  });
"
```

---

## 관련 파일

```
src/
  strategies/
    leverage.ts           ← refreshOracles 호출 위치 (swap 전!)
    deleverage.ts         ← Scallop은 별도 buildScallopDeleverageTransaction으로 분기
  protocols/
    suilend/adapter.ts    ← refreshOracles: obligation 기반 필터링
    navi/adapter.ts       ← refreshOracles: getPriceFeed로 필터링 후 updateOraclePricesPTB
    scallop/adapter.ts    ← refreshOracles: Scallop builder txBlock 주입 방식
```

## 변경 이력

| 날짜 | 변경 | 관련 에러 |
|---|---|---|
| 2026-03 | `refreshOracles`를 swap 앞으로 이동 | Pyth hot potato 충돌 |
| 2026-03 | Scallop `refreshOracles` 구현 (updateAssetPricesQuick) | `price::get_price` abort 1025 |
| 2026-03 | Suilend obligation 기반 coinType 필터링 | `dynamic_field::add` abort 0 (deleverage) |
| 2026-03 | Navi SDK 1.3.10 → 1.3.11 | `oracle_pro::update_single_price` abort 0 |
