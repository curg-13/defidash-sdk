# Protocol APY Research & Implementation Guide

> **대상 독자**: DefiDash SDK 기여자 및 프로토콜 통합 연구자  
> **목적**: 각 lending 프로토콜에서 `getAssetApy`를 네이티브하게 구현하는 방법과 주요 발견 사항을 문서화  
> **최종 검증**: 2026-02-26 (mainnet live data)

---

## 구현 목표

`previewLeverage`가 레버리지 포지션의 순 수익(Net APY)을 계산하려면 각 프로토콜의 다음 네 가지 값이 필요합니다:

| 필드              | 설명                                     |
| ----------------- | ---------------------------------------- |
| `supplyApy`       | 기본 공급 APR (이자율 모델)              |
| `rewardApy`       | 공급 인센티브 리워드 APR                 |
| `totalSupplyApy`  | `supplyApy + rewardApy`                  |
| `borrowApy`       | **순** 차입 비용 (gross - borrow rebate) |
| `borrowRewardApy` | 차입 인센티브 리베이트 APR               |

> **핵심 원칙**: 복잡한 SDK 파싱 함수 의존성 제거 → 각 프로토콜이 이미 계산해서 노출하는 데이터를 직접 활용

---

## 1. Suilend

**파일**: [`src/protocols/suilend/adapter.ts`](../src/protocols/suilend/adapter.ts)

### 공급 APY — simulate 유틸 직접 호출

`parseReserve(reserve, coinMetadataMap)`는 보상 토큰마다 coinMetadata가 필요합니다. 대신 `simulate` 유틸을 raw `Reserve<string>`에 직접 호출합니다:

```typescript
import { calculateDepositAprPercent, calculateBorrowAprPercent }
  from "@suilend/sdk/utils/simulate";

const supplyAprPercent = calculateDepositAprPercent(reserve); // BigNumber (%)
const borrowAprPercent = calculateBorrowAprPercent(reserve);

const supplyApy = supplyAprPercent.div(100).toNumber(); // e.g., 0.0265
const grossBorrowApy = borrowAprPercent.div(100).toNumber(); // e.g., 0.0583
```

### 리워드 APY — poolReward.coinType + getTokenPrice (7k)

`reserve.depositsPoolRewardManager.poolRewards` / `reserve.borrowsPoolRewardManager.poolRewards` 를 순회합니다.

```typescript
const rewardCoinType: string | undefined =
  typeof (poolReward as any).coinType === 'string'
    ? (poolReward as any).coinType
    : (poolReward as any).coinType?.name
      ? String((poolReward as any).coinType.name)
      : undefined;

// 실제 리워드 토큰 가격 (7k getTokenPrice)
let rewardPrice = primaryTokenPrice; // fallback
if (rewardCoinType) {
  const fetchedPrice = await getTokenPrice(rewardCoinType);
  if (fetchedPrice > 0) rewardPrice = new BigNumber(fetchedPrice);
}

const rewardPerYear = totalRewards.times(MS_PER_YEAR).div(durationMs);
apy += rewardPerYear.times(rewardPrice).div(totalUsd).toNumber();
```

### ⚠️ 핵심: 분모 구분

- **공급 리워드**: 분모 = `totalDepositedUsd` (존재하는 예치금 전체)
- **차입 리워드**: 분모 = `totalBorrowedUsd` (차입자에게 지급되므로 차입 규모 대비)

```typescript
const rewardApy = sumRewardApy(reserve.depositsPoolRewardManager.poolRewards, totalDepositedUsd);
const borrowRewardApy = sumRewardApy(reserve.borrowsPoolRewardManager.poolRewards, totalBorrowedUsd);
// 순 차입 비용 = gross - rebate
const netBorrowApy = Math.max(0, grossBorrowApy - borrowRewardApy);
```

> **과거 버그**: 분모를 `totalDepositedUsd`로 통일했을 때 borrow rebate가 1.16%로 과소 계산됨. `totalBorrowedUsd`로 수정 후 2.05%로 대시보드(2%) 근접.

### 실측 APY (2026-02-26)

| Asset | supplyApy | rewardApy | totalSupply | borrowApy (net) | borrowRewardApy |
| ----- | --------- | --------- | ----------- | --------------- | --------------- |
| SUI   | 2.89%     | 0%        | 2.89%       | 2.41%           | 3.28%           |
| USDC  | 2.65%     | 0.50%     | **3.14%**   | 3.78%           | 2.05%           |

> USDC: Interest 2.65% + sSUI Reward 0.50% = **3.14% total** ✅ (대시보드 3.13%)  
> USDC borrow: Gross 5.83% - sSUI rebate 2.05% = **3.78% net** ✅ (대시보드 ~3.83%)

---

## 2. Navi

**파일**: [`src/protocols/navi/adapter.ts`](../src/protocols/navi/adapter.ts)

### 데이터 구조

`getPools()` → `Pool` 타입. 이미 계산된 APY를 문자열 퍼센트로 노출:

```typescript
type Pool = {
  currentBorrowRate: string;   // ⚠️ RAY(10^27) 단위 초당 이자율 — 직접 사용 금지!
  supplyIncentiveApyInfo: {
    vaultApr: string;          // "2.96" → 기본 공급 APR (%)
    apy: string;               // "2.96" → effective total (staking yield 포함)
  };
  borrowIncentiveApyInfo: {
    vaultApr: string;          // "6.63" → gross 차입 APR (%)
    boostedApr: string;        // "4.42" → 차입 인센티브 리베이트 APR
    apy: string;               // "2.21" → net 차입 APY
  };
}
```

### ⚠️ 함정: RAY 단위

`currentBorrowRate = 66286829217831265466436436`를 직접 annualize 하면:

```
(6.63e25 / 10^27) * (365 * 24 * 3600) ≈ 2,090,000%  ❌
```

**올바른 접근**: Pool 객체가 노출하는 pre-computed 문자열 사용:

```typescript
const baseSupplyApr = parseFloat(supplyInfo.vaultApr) / 100;
const totalSupplyApy = parseFloat(supplyInfo.apy) / 100;
const rewardApy = Math.max(0, totalSupplyApy - baseSupplyApr);

const grossBorrowApr = parseFloat(borrowInfo.vaultApr) / 100;
const netBorrowApy = parseFloat(borrowInfo.apy) / 100;   // 이미 rebate 차감
const borrowRewardApy = Math.max(0, grossBorrowApr - netBorrowApy);
```

### 실측 APY (2026-02-26)

| Asset | supplyApy (base) | rewardApy | totalSupply | borrowApy (net) | borrowRewardApy |
| ----- | ---------------- | --------- | ----------- | --------------- | --------------- |
| SUI   | 2.96%            | 0%        | 2.96%       | 2.21%           | 4.42%           |
| USDC  | 3.33%            | 0.61%     | 3.94%       | 4.55%           | 2.36%           |

---

## 3. Scallop

**파일**: [`src/protocols/scallop/adapter.ts`](../src/protocols/scallop/adapter.ts)

### ⚠️ SDK 버그 #1: `isLayerZeroAsset`

`query.getMarketPool(coinName)` → 내부 `getCoinWrappedType()` → `isLayerZeroAsset()` → `Set.has()` on undefined:

```
TypeError: Cannot read properties of undefined (reading 'has')
  at St.isLayerZeroAsset (…/dist/index.mjs:13:132134)
```

**Workaround**: `query.indexer.getMarketPool(coinName)` 직접 호출 → REST API (`/api/market/migrate`) 직접 fetch, 버그 코드 경로 우회:

```typescript
const pool = await this.query.indexer.getMarketPool(coinName);
// pool.supplyApy / pool.borrowApy 는 이미 이자율 모델로 계산된 0-1 decimal
```

### ⚠️ SDK 버그 #2: 차입 인센티브 `getBorrowIncentivePools`

`query.indexer.getBorrowIncentivePools()` → 내부 `reduce` 버그로 실패:

```
TypeError: Cannot read properties of undefined (reading 'reduce')
```

**Workaround**: REST API 직접 fetch:

```typescript
const resp = await fetch('https://sdk.api.scallop.io/api/borrowIncentivePools/migrate');
const data: Record<string, any> = await resp.json();
const pool = Object.values(data).find((p: any) => p?.coinName === coinName);
const rewards: any[] = pool?.rewards ?? []; // ← .points 아닌 .rewards[] 배열!

let borrowRewardApy = 0;
for (const reward of rewards) {
  borrowRewardApy += reward.rewardApr; // 0-1 decimal
}
```

> **주의**: REST API 응답의 키는 `points`가 아닌 **`rewards[]`**. 혼동 주의.

### 실측 APY (2026-02-26)

| Asset | supplyApy | rewardApy | totalSupply | borrowApy (net) | borrowRewardApy |
| ----- | --------- | --------- | ----------- | --------------- | --------------- |
| SUI   | 2.98%     | 0%        | 2.98%       | 3.38%           | 4.84%           |
| USDC  | 5.42%     | 0%        | 5.42%       | 5.77%           | 3.67%           |

> Scallop SUI borrow rebate 4.84% = sSUI 2.58% + sSCA 2.26%  
> 대시보드 "Current Reward APR: 1.55%" 차이 → 대시보드는 stake 수량별 **최소 tier** 기준, SDK는 **base rate** 기준

---

## 전체 비교 (2026-02-26)

### 공급 APY

| 프로토콜 | SUI total | USDC total |
| -------- | --------- | ---------- |
| Suilend  | 2.89%     | 3.14%      |
| Navi     | 2.96%     | 3.94%      |
| Scallop  | 2.98%     | 5.42%      |

### 순 차입 비용 (gross - rebate)

| 프로토콜 | SUI net | SUI rebate | USDC net | USDC rebate |
| -------- | ------- | ---------- | -------- | ----------- |
| Suilend  | 2.41%   | 3.28%      | 3.78%    | 2.05%       |
| Navi     | 2.21%   | 4.42%      | 4.55%    | 2.36%       |
| Scallop  | 3.38%   | 4.84%      | 5.77%    | 3.67%       |

---

## 向後 개선 사항

### 1. 보상 토큰 Metadata Const 테이블

현재 Suilend reward APY는 `poolReward.coinType`를 사용해 7k 가격을 조회하지만, on-chain `coinType` 필드의 실제 구조(string vs object)에 따라 fallback이 발생할 수 있습니다.

well-known 보상 토큰을 const map으로 관리하면 가격 조회 실패를 방지합니다:

```typescript
// src/protocols/suilend/reward-tokens.ts
export const SUILEND_REWARD_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x...::scallop_sui::SCALLOP_SUI": { symbol: "sSUI", decimals: 9 },
};
```

### 2. Scallop SDK 버전 업그레이드 체크

두 가지 SDK 버그(`isLayerZeroAsset`, `getBorrowIncentivePools.reduce`)는 설치된 버전에 한정된 문제입니다. 버전 업그레이드 시 재확인 필요.

### 3. 지원 예정 자산

- **LBTC** (Lombard BTC on Sui)
- **XBTC** (wrapped BTC)

---

## 관련 파일

- [`src/types/protocol.ts`](../src/types/protocol.ts) — `AssetApy` 인터페이스
- [`src/__tests__/getAssetApy.test.ts`](../src/__tests__/getAssetApy.test.ts) — 통합 테스트
- [`src/protocols/suilend/adapter.ts`](../src/protocols/suilend/adapter.ts)
- [`src/protocols/navi/adapter.ts`](../src/protocols/navi/adapter.ts)
- [`src/protocols/scallop/adapter.ts`](../src/protocols/scallop/adapter.ts)
