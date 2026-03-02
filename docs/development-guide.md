# DefiDash SDK Development Guide

> SDK 개발 과정에서 겪은 문제들과 해결 방법을 정리한 가이드.
> 각 섹션은 **문제 → 원인 → 해결** 형식으로 구성되어 있습니다.

---

## Table of Contents

1. [Protocol Architecture Differences](#1-protocol-architecture-differences)
2. [Oracle & Price Feed Issues](#2-oracle--price-feed-issues)
3. [APY Data Implementation](#3-apy-data-implementation)
4. [Risk Parameters Implementation](#4-risk-parameters-implementation)
5. [Gas Cost Analysis](#5-gas-cost-analysis)
6. [SUI Native Coin Handling](#6-sui-native-coin-handling)
7. [Liquidation Mechanics](#7-liquidation-mechanics)
8. [Deleverage Transaction Stability](#8-deleverage-transaction-stability)
9. [USD Value Deposit Feature](#9-usd-value-deposit-feature)

---

## 1. Protocol Architecture Differences

### Scallop: Collateral vs Lending 이중 풀 구조

**문제**: Scallop에 deposit 후 borrow를 시도하면 "No collateral" 에러가 발생.

**원인**: Scallop은 Aave/Compound와 달리 **Lending Pool**(이자 수익)과 **Collateral Pool**(차입 담보)을 분리합니다.

| Pool Type | 이자 수익 | 차입 가능 |
|-----------|----------|----------|
| Lending Pool (`depositQuick`) | O | X |
| Collateral Pool (`addCollateralQuick`) | X | O |

**해결**: 레버리지 전략에서는 반드시 `addCollateralQuick`을 사용하여 Collateral Pool에 예치합니다. Lending Pool deposit은 차입 담보로 사용할 수 없습니다.

```typescript
// Wrong: deposit은 이자만 받고 차입 불가
await scallopTxBlock.depositQuick(amount, 'sui');
await scallopTxBlock.borrowQuick(50, 'usdc');  // Error!

// Correct: addCollateral로 담보 예치 후 차입
await scallopTxBlock.addCollateralQuick(amount, 'sui', obligationId);
await scallopTxBlock.borrowQuick(50, 'usdc', obligationId);  // Works
```

### Scallop Obligation 시스템

Scallop은 Obligation 오브젝트로 포지션을 관리합니다:
- 지갑당 최대 5개 sub-account (Obligation) 가능
- Obligation이 **staked** 상태면 unstake 후 작업 필요
- 레버리지/디레버리지 시 obligation 상태 확인이 선행되어야 함

---

## 2. Oracle & Price Feed Issues

> 상세 트러블슈팅은 [oracle-troubleshooting.md](./oracle-troubleshooting.md) 참조

### Problem 2-1: Suilend PTB 내 stale oracle

**문제**: Flash Loan → Swap → Deposit → Borrow 플로우에서 Borrow 시 `assert_no_stale_oracles` abort 9.

**원인**: `borrow(addRefreshCalls=true)` 시 SDK가 on-chain obligation을 조회하는데, PTB 내의 deposit은 아직 on-chain에 반영되지 않아 해당 reserve의 oracle이 refresh되지 않음.

```
On-chain State (조회 시점)     PTB 내부 상태 (실행 예정)
┌────────────────────────┐    ┌────────────────────────┐
│ Obligation:            │    │ Obligation:            │
│   deposits: [기존]     │    │   deposits: [기존 + LBTC]│
│   borrows: [기존]      │    │   borrows: [기존 + USDC] │
└────────────────────────┘    └────────────────────────┘
     getObligation() 조회        실제 실행될 상태
     (LBTC deposit 없음!)       (LBTC deposit 있음)
```

**해결**: deposit **전에** `refreshAll`을 호출하고, deposit/borrow할 coinType을 명시적으로 전달. 이후 `borrow(addRefreshCalls=false)`로 중복 refresh 방지.

```typescript
// deposit 전에 모든 관련 coinType refresh
await suilendClient.refreshAll(tx, obligation, [depositCoinType, borrowCoinType]);

// deposit
suilendClient.deposit(coin, depositCoinType, cap, tx);

// borrow — addRefreshCalls=false (이미 refresh 완료)
await suilendClient.borrow(cap, obligationId, borrowCoinType, amount, tx, false);
```

### Problem 2-2: Pyth Hot Potato 충돌

**문제**: 레버리지 TX가 **간헐적으로** `dynamic_field::add` abort 0 에러. 같은 코드가 때로는 성공, 때로는 실패.

**원인**: Pyth on Sui의 `updatePriceFeeds`는 hot potato 패턴 사용 (create → update → cleanup). 7k swap 라우팅이 내부적으로 Pyth 업데이트를 추가할 수 있고, `refreshOracles`도 같은 price feed를 업데이트하면 중복 `dynamic_field::add` 발생.

**해결**: `refreshOracles`를 7k swap **이전에** 호출하여 Pyth lifecycle이 겹치지 않도록 순서 보장.

```typescript
// leverage.ts 내 순서
const [loanCoin, receipt] = flashLoanClient.borrowFlashLoan(tx, ...);
await protocol.refreshOracles(tx, [depositCoinType, USDC], userAddress); // swap 전!
const swappedAsset = await swapClient.swap({ ... });                     // swap 후
```

### Problem 2-3: Suilend refreshAll Map key 타입 불일치

**문제**: Suilend deleverage에서 `dynamic_field::add` abort 0.

**원인**: `@suilend/sdk` v1.x의 `refreshAll()`에서 obligation entries는 string key, `findReserveArrayIndex`는 BigInt key를 사용. JavaScript Map에서 `"3" !== 3n`이므로 같은 reserve가 2번 등록 → Pyth VAA 중복 제출.

**해결**: obligation 내 기존 coinTypes를 필터링하여 Map 중복 방지:

```typescript
const existingCoinTypes = new Set<string>();
obligation.deposits.forEach(d => existingCoinTypes.add(normalizeCoinType(d.coinType.name)));
obligation.borrows.forEach(b => existingCoinTypes.add(normalizeCoinType(b.coinType.name)));

const newCoinTypes = coinTypes.filter(ct => !existingCoinTypes.has(normalizeCoinType(ct)));
await this.client.refreshAll(tx, obligation, newCoinTypes.length > 0 ? newCoinTypes : undefined);
```

### Problem 2-4: Scallop xOracle 미갱신

**문제**: Scallop borrow/withdraw 시 `price::get_price` abort 1025 (가격 데이터 없음).

**원인**: `ScallopAdapter.refreshOracles()`가 no-op (빈 함수). Scallop은 xOracle 자체 시스템 사용.

**해결**: Scallop SDK builder를 기존 Transaction에 주입하여 xOracle 업데이트 추가:

```typescript
async refreshOracles(tx: Transaction, coinTypes: string[]): Promise<void> {
  const builder = await this.scallop.createScallopBuilder();
  const scallopTx = builder.createTxBlock();
  scallopTx.txBlock = tx;  // 핵심: 기존 tx에 oracle 명령 주입
  await scallopTx.updateAssetPricesQuick(coinNames);
}
```

### Problem 2-5: Navi Oracle Config 불일치

**문제**: `oracle_pro::update_single_price` abort 0. 코드 변경 없이 갑자기 발생.

**원인**: Navi SDK가 하드코딩하는 oracle object ID가 on-chain 업그레이드로 변경됨.

**해결**: Navi SDK 업데이트 (`npm install @naviprotocol/lending@latest`). 실제 사례: v1.3.10 → v1.3.11.

---

## 3. APY Data Implementation

### Problem 3-1: Navi RAY 단위 함정

**문제**: `currentBorrowRate = 66286829217831265466436436`를 직접 annualize하면 2,090,000% APY 산출.

**원인**: Navi의 `currentBorrowRate`는 RAY(10^27) 단위 **초당** 이자율. 직접 사용 금지.

**해결**: Pool 객체가 노출하는 pre-computed 문자열 사용:

```typescript
// Wrong: RAY 단위 직접 변환
const apy = (6.63e25 / 1e27) * (365 * 24 * 3600);  // 2,090,000% ❌

// Correct: pre-computed 값 사용
const baseSupplyApr = parseFloat(pool.supplyIncentiveApyInfo.vaultApr) / 100;  // ✅
const netBorrowApy = parseFloat(pool.borrowIncentiveApyInfo.apy) / 100;        // ✅
```

### Problem 3-2: Scallop SDK `isLayerZeroAsset` 크래시

**문제**: `query.getMarketPool(coinName)` 호출 시 `TypeError: Cannot read properties of undefined (reading 'has')`.

**원인**: Scallop SDK v2.3.14-rc.1 내부의 `isLayerZeroAsset()` → `Set.has()` on undefined.

**해결**: `query.indexer.getMarketPool(coinName)` 직접 호출 (REST API 경유, 버그 코드 경로 우회):

```typescript
const pool = await this.query.indexer.getMarketPool(coinName);
// pool.supplyApy / pool.borrowApy 는 0-1 decimal
```

### Problem 3-3: Scallop `getBorrowIncentivePools` 크래시

**문제**: `query.indexer.getBorrowIncentivePools()` 호출 시 `TypeError: ... (reading 'reduce')`.

**해결**: REST API 직접 fetch:

```typescript
const resp = await fetch('https://sdk.api.scallop.io/api/borrowIncentivePools/migrate');
const data = await resp.json();
const pool = Object.values(data).find((p: any) => p?.coinName === coinName);
const rewards = pool?.rewards ?? [];  // .points가 아닌 .rewards[] 배열
```

### Problem 3-4: Suilend borrow reward 분모 오류

**문제**: Borrow rebate APY가 대시보드(2.05%)보다 낮게 계산됨 (1.16%).

**원인**: 공급 리워드와 차입 리워드의 분모가 달라야 하는데 둘 다 `totalDepositedUsd` 사용.

**해결**: 차입 리워드는 `totalBorrowedUsd`를 분모로 사용:

```typescript
const rewardApy = sumRewardApy(depositsPoolRewards, totalDepositedUsd);       // 공급 리워드
const borrowRewardApy = sumRewardApy(borrowsPoolRewards, totalBorrowedUsd);   // 차입 리워드 (분모 다름!)
const netBorrowApy = Math.max(0, grossBorrowApy - borrowRewardApy);
```

### APY 비교 (2026-02-26 기준)

| Protocol | SUI Supply | USDC Supply | SUI Borrow (net) | USDC Borrow (net) |
|----------|-----------|-------------|-------------------|-------------------|
| Suilend  | 2.89%     | 3.14%       | 2.41%             | 3.78%             |
| Navi     | 2.96%     | 3.94%       | 2.21%             | 4.55%             |
| Scallop  | 2.98%     | 5.42%       | 3.38%             | 5.77%             |

---

## 4. Risk Parameters Implementation

### Problem 4-1: Navi 다중 형식 LTV

**문제**: Navi Pool의 LTV 값이 `650000000000000000000000000`, `65`, `0.65` 중 하나로 반환됨.

**원인**: Navi SDK가 반환하는 값의 형식이 일관되지 않음.

**해결**: 값 크기에 따라 형식 자동 감지:

```typescript
if (ltvValue > 1e20) ltv = ltvValue / 1e27;     // RAY (10^27)
else if (ltvValue > 1) ltv = ltvValue / 100;     // Percentage (0-100)
else ltv = ltvValue;                              // Decimal (0-1)
```

### Problem 4-2: Scallop SDK `queryMarket()` 크래시

**문제**: Scallop SDK의 `queryMarket()`이 `isLayerZeroAsset` 내부에서 크래시. v2.4.0은 ESM-only로 CJS 호환 불가.

**해결**: 온체인 `risk_models` Dynamic Field를 직접 RPC로 조회:

```typescript
// Step 1: Market object에서 risk_models 테이블 ID 조회
const marketObj = await suiClient.getObject({ id: marketId, options: { showContent: true } });
const riskModelTableId = marketFields?.risk_models?.fields?.table?.fields?.id?.id;

// Step 2: Dynamic field 조회 (주의: "0x" prefix 제거 필요)
const resp = await suiClient.getDynamicFieldObject({
  parentId: riskModelTableId,
  name: { type: "0x1::type_name::TypeName", value: { name: coinTypeKey } },
});

// Step 3: FixedPoint32 파싱 (Move의 FixedPoint32 = u64 / 2^32)
const DIVISOR = 2 ** 32;  // 4294967296
const ltv = Number(rm.collateral_factor?.fields?.value) / DIVISOR;
```

### Problem 4-3: Navi LTV > liquidationThreshold

**문제**: Navi SUI에서 `LTV(75%) > liquidationThreshold(70%)`로 일반적인 `threshold >= ltv` 가정이 깨짐.

**원인**: Navi의 의도적 설계. 테스트에서 `threshold >= ltv` 단언을 하지 않아야 함.

### Risk Parameters 비교 (SUI 기준)

| Protocol | LTV | Liq. Threshold | Max Multiplier |
|----------|-----|---------------|----------------|
| Suilend  | 70% | 75%           | 3.33x          |
| Navi     | 75% | 70%           | 4.00x          |
| Scallop  | 85% | 90%           | 6.67x          |

---

## 5. Gas Cost Analysis

### Suilend vs Scallop 가스 비용

**실측 결과**:
- Suilend: ~0.04 SUI
- Scallop: ~0.08 SUI (약 2배)

**원인 분석**:

| 항목 | Suilend | Scallop |
|------|---------|---------|
| Oracle 패턴 | Lazy refresh (별도 호출, 캐시) | Inline refresh (매 작업마다 조회) |
| 가치 계산 | 캐시된 USD 값 사용 — O(1) | 매번 모든 collateral/debt 순회 — O(n+m) |
| Oracle 시스템 | Pyth 직접 사용 | xOracle 추상화 (4+ Move calls/asset) |

**Leverage 시나리오 Move call 비교** (1 collateral, 1 debt):

| 단계 | Suilend | Scallop |
|------|---------|---------|
| Flash loan | 1 | 1 |
| Swap | 1 | 1 |
| Oracle refresh | 2 | 8+ |
| Deposit | 1 | 1 |
| Borrow | 1 (캐시) | 1 + 2 inline oracle |
| Repay flash loan | 1 | 1 |
| **Total** | **~7** | **~15+** |

포지션이 복잡해질수록 (3+ collateral, 2+ debt) 격차가 더 벌어짐.

---

## 6. SUI Native Coin Handling

### Problem: SUI 토큰 gas 충돌

**문제**: SUI를 deposit asset으로 사용할 때 `No valid gas coins found` 또는 `InsufficientCoinBalance`.

**원인**: SUI는 gas 비용 지불에도 사용되는 네이티브 토큰. 일반 토큰처럼 coin object를 전부 merge하면 gas 비용 지불용 SUI가 없어짐.

**해결**: SUI와 non-SUI를 분기 처리:

```typescript
if (isSui) {
  // tx.gas에서 필요한 양만 split → 나머지는 gas로 자동 사용
  const [userDeposit] = tx.splitCoins(tx.gas, [BigInt(DEPOSIT_AMOUNT)]);
  tx.mergeCoins(userDeposit, [swappedAsset]);
  depositCoin = userDeposit;
} else {
  // 지갑에서 coin object 조회 → merge → swapped asset과 합침
  const userCoins = await suiClient.getCoins({ owner, coinType });
  const primaryCoin = tx.object(userCoins.data[0].coinObjectId);
  if (userCoins.data.length > 1) {
    tx.mergeCoins(primaryCoin, userCoins.data.slice(1).map(c => tx.object(c.coinObjectId)));
  }
  tx.mergeCoins(primaryCoin, [swappedAsset]);
  depositCoin = primaryCoin;
}
```

> 참고: Suilend SDK의 `depositIntoObligation`도 동일한 `isSui ? tx.gas : tx.object(coin)` 패턴 사용.

---

## 7. Liquidation Mechanics

### Suilend 청산 공식

**Health Factor**:
```
HF = UnhealthyBorrowLimit / WeightedBorrows
```
- HF > 1: 안전
- HF < 1: 청산 대상

**Liquidation Price** (단일 Collateral C, 단일 Debt D):
```
LiqPrice_C = (Debt × Price_D × Weight_D) / (Collateral × CloseLTV_C)
```

**Max Leverage Multiplier**:
```
MaxMultiplier = 1 / (1 - LTV)
```

### 청산 프로세스

Suilend는 **Partial Liquidation** 모델:
- **Close Factor**: 20% — 한 번에 최대 20% 부채만 청산
- **Liquidation Bonus**: 5% — 청산자에게 담보의 5% 추가 지급

청산 플로우:
1. HF < 1.0 → 청산 대상
2. 청산봇이 부채의 20% 상환
3. 프로토콜이 해당 가치 + 5% 보너스만큼 담보를 청산자에게 이전
4. 부채 감소 → HF 개선

### 청산 방지 전략

- Health Factor 1.5 이상 유지 권장
- 시장 하락 시 부채 일부 상환 또는 담보 추가
- 각 자산별 Close LTV 차이 인지 필요

---

## 8. Deleverage Transaction Stability

### Problem 8-1: 7k swap settle abort

**문제**: Deleverage 시 7k Protocol의 `settle` 함수에서 MoveAbort code 0.

**원인**: 소액 collateral→USDC 스왑 ($1-2)에서 1% slippage tolerance가 너무 타이트함.

**해결**: Deleverage 전용 slippage를 5% (500 BPS)로 설정:

```typescript
const DELEVERAGE_SLIPPAGE_BPS = 500; // 5% (leverage는 1% 유지)
```

### Problem 8-2: InsufficientCoinBalance on flash loan repay

**문제**: Slippage 수정 후에도 flash loan 상환 시 잔액 부족.

**원인**: Swap buffer(2%)가 slippage tolerance(5%)보다 작아서, 실제 swap output이 flash loan 상환에 필요한 금액보다 적을 수 있음.

**해결**: Swap buffer를 slippage tolerance보다 크게 설정 (10%):

```typescript
// Buffer는 반드시 DELEVERAGE_SLIPPAGE_BPS(5%)보다 커야 함
const targetUsdcOut = (totalRepayment * 110n) / 100n;  // 10% buffer
```

### Problem 8-3: SharedObjectCongestion

**문제**: 연속 deleverage TX 실행 시 `SharedObjectCongestion` 및 stale object version 에러.

**원인**: Sui에서 같은 shared object (Scallop market)를 연속 TX가 접근할 때 발생. 이전 TX의 on-chain finality 전에 다음 TX가 실행되면 stale reference.

**해결**: Execute 모드에서 deleverage TX 간 3초 딜레이 추가:

```typescript
if (!dryRun && result.success) {
  console.log('  Waiting 3s for on-chain finality...');
  await new Promise(resolve => setTimeout(resolve, 3000));
}
```

---

## 9. USD Value Deposit Feature

### 구현 배경

**문제**: Raw token amount (e.g., `0.00001 LBTC`)로 입력하면 자산별 decimal 차이로 혼란.

**해결**: `depositValueUsd` 파라미터 추가 — USD 금액으로 입력하면 자동 변환.

```typescript
// Raw amount (기존)
await sdk.buildLeverageTransaction(tx, {
  depositAmount: "0.00001",  // 0.00001 LBTC
  ...
});

// USD value (추가)
await sdk.buildLeverageTransaction(tx, {
  depositValueUsd: 1.0,  // $1 worth of LBTC (auto-calculated)
  ...
});
```

**제약사항**:
- `depositAmount`와 `depositValueUsd` 중 하나만 제공 (둘 다 제공 시 에러)
- 가격 소스: `@7kprotocol/sdk-ts`의 `getTokenPrice()` — SDK 내부 계산과 일관성 유지

---

## Dependency Constraints

현재 SDK의 주요 의존성 제약:

| 제약 | 상세 |
|------|------|
| `@suilend/sdk` v2.0 불가 | v2.0은 `@mysten/sui` v2.x 요구, `@7kprotocol/sdk-ts`는 v1.x만 지원 |
| Scallop SDK v2.4.0 불가 | ESM-only로 CJS 프로젝트와 호환 불가 |
| Navi SDK 주기적 확인 필요 | Oracle config 변경 시 SDK 업데이트 없이는 abort 발생 |

---

## Related Documentation

- [Oracle Troubleshooting](./oracle-troubleshooting.md) — 오라클 에러 진단 플로우차트
- [Leverage Flash Loan Flow](./leverage-flash-loan-flow.md) — 레버리지 아키텍처 상세
- [Adding New Protocol](./adding-new-protocol.md) — 프로토콜 어댑터 추가 가이드
- [SDK Method Reference](./sdk-methods/index.md) — 공개 API 문서
