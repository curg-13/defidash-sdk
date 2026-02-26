# Protocol APY Research & Implementation Guide

> **대상 독자**: DefiDash SDK 기여자 및 프로토콜 통합 연구자  
> **목적**: 각 lending 프로토콜에서 `getAssetApy`를 네이티브하게 구현하는 방법과 그 과정에서 발견한 특이점을 문서화

---

## 배경

`previewLeverage` 기능은 레버리지 포지션의 예상 순 수익(Net APY)을 계산하기 위해 각 프로토콜의 현재 공급/차입 APY가 필요합니다.

초기 구현 시도에서 각 SDK의 고수준 파싱 함수(`parseReserve` 등)를 사용하려 했으나, 이 함수들이 보상 토큰 메타데이터 전체를 요구하는 등 복잡한 의존성이 있었습니다. 따라서 **각 프로토콜이 이미 계산해서 노출하는 데이터를 최대한 직접 활용**하는 네이티브 접근 방식으로 전환했습니다.

---

## 1. Suilend

### 구현 파일

[`src/protocols/suilend/adapter.ts`](../src/protocols/suilend/adapter.ts) — `getAssetApy()` 메서드

### 데이터 구조

Suilend SDK의 `LendingMarket.reserves`는 raw `Reserve<string>[]` 배열을 노출합니다.

```typescript
// reserve 내 APY 관련 필드
reserve.availableAmount      // u64 (raw, mint decimals 단위)
reserve.borrowedAmount.value // u256 WAD (10^18 기준)
reserve.price.value          // u256 WAD
reserve.mintDecimals          // number
reserve.depositsPoolRewardManager.poolRewards // 보상 토큰 목록
```

### 구현 전략

`parseReserve(reserve, coinMetadataMap)` 를 사용하면 **보상 토큰마다 coinMetadata가 있어야** 합니다. 대신 `simulate` 유틸을 raw reserve에 직접 호출합니다:

```typescript
import { calculateDepositAprPercent, calculateBorrowAprPercent }
  from "@suilend/sdk/utils/simulate";

const supplyAprPercent = calculateDepositAprPercent(reserve); // BigNumber (%, e.g. 2.65)
const borrowAprPercent = calculateBorrowAprPercent(reserve);

const supplyApy = supplyAprPercent.div(100).toNumber(); // 0.0265
const borrowApy = borrowAprPercent.div(100).toNumber(); // 0.0583
```

`simulate` 함수는 raw reserve만으로 이자율 모델 계산이 가능합니다.

### Reward APY 추정

```typescript
const SUILEND_WAD = 10n ** 18n;
// poolRewards 순회 → endTimeMs가 현재 이후인 활성 rewards만
for (const reward of reserve.depositsPoolRewardManager.poolRewards) {
  const totalRewards = new BigNumber(reward.totalRewards.toString()).div(10 ** 9);
  const rewardPerYear = totalRewards.times(MS_PER_YEAR).div(durationMs);
  // ⚠️ 보상 토큰 가격을 모르므로 주 토큰 가격으로 proxy 추정 (best-effort)
  rewardApy += rewardPerYear.times(price).div(totalDepositedUsd).toNumber();
}
```

> **주의**: 보상 토큰 가격 없이 정확한 reward APY 계산이 어렵습니다.  
> 이 문제는 보상 토큰 const metadata 테이블 구축으로 해결 예정입니다.

### 실측 APY (mainnet, 2026-02-26 기준)

| Asset | supplyApy | rewardApy | totalSupplyApy | borrowApy |
| ----- | --------- | --------- | -------------- | --------- |
| SUI   | 2.89%     | 0%        | 2.89%          | 5.69%     |
| USDC  | 2.65%     | 0.50%     | **3.13%**      | 5.83%     |

---

## 2. Navi

### 구현 파일

[`src/protocols/navi/adapter.ts`](../src/protocols/navi/adapter.ts) — `getAssetApy()` 메서드

### 데이터 구조

`@naviprotocol/lending`의 `getPools()` 가 반환하는 `Pool` 타입:

```typescript
type Pool = {
  currentBorrowRate: string;   // RAY(10^27) 단위 초당 이자율 — 직접 쓰면 수백만%!
  currentSupplyRate: string;   // 동일
  supplyIncentiveApyInfo: {
    vaultApr: string;          // "2.96" → 2.96%  (base supply APR)
    apy: string;               // "2.96" → 2.96%  (effective total APY)
    stakingYieldApy: string;   // LST staking yield 포함 시 별도 표시
  };
  borrowIncentiveApyInfo: {
    vaultApr: string;          // "6.63" (gross borrow cost)
    boostedApr: string;        // "4.42" (borrow incentive rebate APR)
    apy: string;               // "2.21" (net effective borrow APY)
  };
}
```

### ⚠️ 함정: RAY 단위 오해

`currentBorrowRate` / `currentSupplyRate`는 Aave 스타일의 **RAY(10²⁷) per-second** 단위입니다.

```
currentBorrowRate = 66286829217831265466436436
→ (66286829217831265466436436 / 10^27) * (365 * 24 * 3600) ≈ 2,090,000%  ❌
```

Navi는 **이미 계산된 APY 문자열**을 Pool 객체에 노출하고 있으므로, 직접 파싱하는 것이 올바릅니다:

```typescript
const supplyInfo = pool.supplyIncentiveApyInfo;
// "2.96%" → 0.0296
const baseSupplyApr = parseFloat(supplyInfo.vaultApr) / 100;
const totalSupplyApy = parseFloat(supplyInfo.apy) / 100;
const rewardApy = Math.max(0, totalSupplyApy - baseSupplyApr);

const borrowApy = parseFloat(pool.borrowIncentiveApyInfo.vaultApr) / 100;
```

### 실측 APY (mainnet, 2026-02-26 기준)

| Asset | supplyApy (base) | rewardApy | totalSupplyApy | borrowApy (gross) |
| ----- | ---------------- | --------- | -------------- | ----------------- |
| SUI   | 2.96%            | 0%        | 2.96%          | 6.63%             |
| USDC  | 3.33%            | 0.61%     | 3.94%          | 6.91%             |

---

## 3. Scallop

### 구현 파일

[`src/protocols/scallop/adapter.ts`](../src/protocols/scallop/adapter.ts) — `getAssetApy()` 메서드

### 데이터 구조

Scallop SDK의 `ScallopQuery.getMarketPool(coinName)` → `MarketPool`:

```typescript
type MarketPool = {
  supplyApr: number;    // 0-1 decimal (이자율 모델로 계산)
  supplyApy: number;    // APR을 APY로 변환
  borrowApr: number;
  borrowApy: number;
  // ...
}
```

### ⚠️ SDK 버그: `isLayerZeroAsset`

설치된 버전(`@scallop-io/sui-scallop-sdk`)의 `getMarketPool()`은 내부적으로 `getCoinWrappedType()` → `isLayerZeroAsset()`를 호출하는데, `ScallopUtils`의 whitelist `Set`이 초기화되지 않은 경우 충돌합니다:

```
TypeError: Cannot read properties of undefined (reading 'has')
  at St.isLayerZeroAsset (…/dist/index.mjs:13:132134)
```

**workaround**: SDK의 `indexer`를 직접 호출하면 이 코드 경로를 완전히 우회합니다:

```typescript
// ✅ 정상 동작: indexer는 REST API 직접 호출 (sdk.api.scallop.io)
const pool = await this.query.indexer.getMarketPool(coinName);

// ❌ 버그 발생
const pool = await this.query.getMarketPool(coinName);
const pool = await this.query.getMarketPool(coinName, { indexer: true }); // 동일 버그
```

> **향후 대응**: `@scallop-io/sui-scallop-sdk` 버전 업그레이드 후 재확인 필요

### 실측 APY (mainnet, 2026-02-26 기준)

| Asset | supplyApy | rewardApy | totalSupplyApy | borrowApy |
| ----- | --------- | --------- | -------------- | --------- |
| SUI   | 2.98%     | 0%        | 2.98%          | 8.23%     |
| USDC  | 5.42%     | 0%        | 5.42%          | 9.44%     |

---

## 전체 비교 (2026-02-26 기준)

| 프로토콜 | SUI supply | USDC supply | SUI borrow | USDC borrow |
| -------- | ---------- | ----------- | ---------- | ----------- |
| Suilend  | 2.89%      | **3.13%\*** | 5.69%      | 5.83%       |
| Navi     | 2.96%      | 3.94%       | 6.63%      | 6.91%       |
| Scallop  | 2.98%      | 5.42%       | 8.23%      | 9.44%       |

> \* Suilend USDC: Interest 2.65% + sSUI Reward 0.49% = **3.13% total**

---

## 향후 개선 사항

### 보상 토큰 Metadata Const 테이블

현재 Suilend reward APY는 보상 토큰 가격 없이 추정하므로 부정확합니다.  
well-known 보상 토큰 목록을 const로 관리하고, 하루 1회 가격을 업데이트하는 구조가 필요합니다:

```typescript
// 예시: src/protocols/suilend/reward-tokens.ts
export const SUILEND_REWARD_TOKENS: Record<string, { symbol: string; decimals: number }> = {
  "0x...::ssui::SSUI": { symbol: "sSUI", decimals: 9 },
  // ...
};
```

### 지원 예정 자산

- **LBTC** (Lombard BTC on Sui)
- **XBTC** (wBTC bridge variant on Sui)

wrapped BTC 자산들의 APY 확인이 필요합니다.

---

## 관련 파일

- [`src/types/protocol.ts`](../src/types/protocol.ts) — `AssetApy` 인터페이스
- [`src/__tests__/getAssetApy.test.ts`](../src/__tests__/getAssetApy.test.ts) — 통합 테스트
- [`src/protocols/suilend/adapter.ts`](../src/protocols/suilend/adapter.ts)
- [`src/protocols/navi/adapter.ts`](../src/protocols/navi/adapter.ts)
- [`src/protocols/scallop/adapter.ts`](../src/protocols/scallop/adapter.ts)
