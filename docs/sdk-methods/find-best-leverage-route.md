# `sdk.findBestLeverageRoute()` — Auto Protocol Routing

> **대상 독자**: DefiDash SDK 사용자 및 프론트엔드 개발자
> **목적**: `findBestLeverageRoute` 메서드의 입출력, 내부 로직, 프로토콜 비교 방식 문서화

---

## 개요

`findBestLeverageRoute`는 주어진 자산에 대해 **모든 초기화된 프로토콜을 자동으로 비교**하여 최적의 레버리지 경로를 찾아줍니다.

두 가지 추천을 반환합니다:
1. **bestMaxMultiplier** — 가장 높은 레버리지를 제공하는 프로토콜
2. **bestApy** — 안전한 배율에서 가장 높은 순 APY를 제공하는 프로토콜

```typescript
const route = await sdk.findBestLeverageRoute({
  depositAsset: 'SUI',
  depositValueUsd: 100,
});

console.log(route.bestMaxMultiplier.protocol); // e.g. 'scallop'
console.log(route.bestApy.protocol);           // e.g. 'suilend'
console.log(route.safeMultiplier);             // e.g. 2.36
```

---

## Input Parameters

```typescript
sdk.findBestLeverageRoute(params: {
  depositAsset: string;       // 'SUI', 'XBTC', 'LBTC', or full coin type
  depositAmount?: string;     // Human-readable amount (e.g., "1.5")
  depositValueUsd?: number;   // USD value (e.g., 100 for $100)
}): Promise<LeverageRouteResult>
```

| 파라미터 | 필수 | 설명 |
|----------|------|------|
| `depositAsset` | O | 담보 자산 심볼 또는 full coin type |
| `depositAmount` | △ | 토큰 수량 (depositValueUsd와 택 1) |
| `depositValueUsd` | △ | USD 가치 (depositAmount와 택 1) |

> **주의**: `depositAmount`와 `depositValueUsd` 중 정확히 하나만 제공해야 합니다.
> **protocol이나 multiplier는 불필요** — 메서드가 자동으로 최적 값을 결정합니다.

---

## Output: `LeverageRouteResult`

| 필드 | 타입 | 설명 |
|------|------|------|
| `bestMaxMultiplier` | `LeverageRoute` | 최고 레버리지 프로토콜 + 해당 배율의 preview |
| `bestApy` | `LeverageRoute` | 최고 APY 프로토콜 + safe multiplier에서의 preview |
| `safeMultiplier` | `number` | APY 비교용 안전 배율 |
| `allPreviews` | `Array<{protocol, preview}>` | 모든 성공 프로토콜의 preview 배열 |
| `failedProtocols` | `Array<{protocol, error}>` | 실패한 프로토콜 (디버깅용) |

### `LeverageRoute` 구조

| 필드 | 타입 | 설명 |
|------|------|------|
| `protocol` | `LendingProtocol` | 프로토콜 식별자 |
| `multiplier` | `number` | 해당 preview에 사용된 배율 |
| `preview` | `LeveragePreview` | 전체 preview 데이터 ([상세](./preview-leverage.md)) |

---

## 내부 계산 흐름

```
findBestLeverageRoute(params)
  │
  ├── Phase 1: Risk Params (lightweight, parallel)
  │     ├── getAssetRiskParams(coinType) for each protocol
  │     └── Collect maxMultiplier values
  │
  ├── Safe Multiplier Calculation
  │     └── safeMultiplier = max(1.1, min(maxMultipliers) - 0.5)
  │
  ├── Best Max Multiplier
  │     └── Protocol with highest maxMultiplier
  │
  ├── Phase 2: Previews (parallel)
  │     ├── previewLeverage(bestMaxProtocol, maxMult - 0.01)  → bestMaxMultiplier preview
  │     └── previewLeverage(each protocol, safeMultiplier)     → APY comparison previews
  │
  └── Best APY
        └── Protocol with highest netApy at safeMultiplier
```

---

## Safe Multiplier 공식

```
safeMultiplier = max(1.1, min(maxMultiplier₁, maxMultiplier₂, ...) - BUFFER)
```

- `BUFFER` = 0.5 (상수 `LEVERAGE_MULTIPLIER_BUFFER`)
- Floor = 1.1x (최소 배율)
- 모든 프로토콜에서 안전하게 사용 가능한 공통 배율

**예시**: Suilend max 2.86x, Navi max 4.0x, Scallop max 6.67x
→ safeMultiplier = max(1.1, 2.86 - 0.5) = **2.36x**

---

## 에러 처리

| 에러 | 원인 | 해결 |
|------|------|------|
| `InvalidParameterError` | depositAmount/depositValueUsd 둘 다 or 미제공 | 하나만 제공 |
| `InvalidParameterError` | 모든 프로토콜에서 해당 자산 미지원 | 지원 자산 확인 |
| `InvalidParameterError` | safe multiplier에서 모든 preview 실패 | 로그의 failedProtocols 확인 |

---

## 프론트엔드 사용 예시

```typescript
import { DefiDashSDK, LendingProtocol } from '@defidash/sdk';

const route = await sdk.findBestLeverageRoute({
  depositAsset: 'SUI',
  depositValueUsd: 1000,
});

// UI: "Best leverage" 카드
const maxCard = {
  protocol: route.bestMaxMultiplier.protocol,
  multiplier: `${route.bestMaxMultiplier.multiplier}x`,
  apy: `${(route.bestMaxMultiplier.preview.netApy * 100).toFixed(2)}%`,
};

// UI: "Best return" 카드
const apyCard = {
  protocol: route.bestApy.protocol,
  multiplier: `${route.bestApy.multiplier}x`,
  apy: `${(route.bestApy.preview.netApy * 100).toFixed(2)}%`,
};

// UI: Protocol comparison table
const comparison = route.allPreviews.map(({ protocol, preview }) => ({
  protocol,
  netApy: `${(preview.netApy * 100).toFixed(2)}%`,
  maxMultiplier: `${preview.maxMultiplier.toFixed(1)}x`,
  liquidationPrice: `$${preview.liquidationPrice.toFixed(2)}`,
}));
```

---

## Standalone Function (Advanced)

SDK 클래스 없이 직접 사용할 수 있습니다:

```typescript
import { findBestLeverageRoute } from '@defidash/sdk';

const result = await findBestLeverageRoute(params, {
  protocols: myProtocolMap,
  previewFn: myPreviewFunction,
  resolveCoinType: myCoinResolver,
});
```

---

## 관련 문서

- [Preview Leverage](./preview-leverage.md) — 개별 프로토콜 preview 상세
- [Leverage](./leverage.md) — 레버리지 실행
