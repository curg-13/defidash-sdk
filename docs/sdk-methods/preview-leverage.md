# `sdk.previewLeverage()` — Leverage Position Preview

> **대상 독자**: DefiDash SDK 사용자 및 프론트엔드 개발자
> **목적**: `previewLeverage` 메서드의 입출력, 내부 계산 로직, 프로토콜별 데이터 소스를 문서화
> **최종 검증**: 2026-02-26 (mainnet live data)

---

## 개요

`previewLeverage`는 레버리지 포지션을 **실행하지 않고** 예상 결과를 미리 계산합니다.
프론트엔드에서 사용자에게 포지션 크기, 청산 리스크, 예상 수익을 보여줄 때 사용합니다.

```typescript
const preview = await sdk.previewLeverage({
  protocol: LendingProtocol.Suilend,
  depositAsset: 'SUI',
  depositValueUsd: 100,   // $100 worth of SUI
  multiplier: 2.0,         // 2x leverage
});

console.log(preview.netApy);           // 2.33% (annualized return on equity)
console.log(preview.liquidationPrice); // $0.63 (SUI price at which liquidation occurs)
console.log(preview.maxMultiplier);    // 3.33x (max allowed by protocol LTV)
```

---

## Input Parameters

```typescript
sdk.previewLeverage(params: {
  protocol: LendingProtocol;      // 'suilend' | 'navi' | 'scallop'
  depositAsset: string;            // 'SUI', 'XBTC', 'LBTC', or full coin type
  depositAmount?: string;          // Human-readable amount (e.g., "1.5")
  depositValueUsd?: number;        // USD value (e.g., 100 for $100)
  multiplier: number;              // Target leverage (e.g., 2.0 for 2x)
}): Promise<LeveragePreview>
```

| 파라미터 | 필수 | 설명 |
|----------|------|------|
| `protocol` | O | 대상 프로토콜 |
| `depositAsset` | O | 담보 자산 심볼 또는 full coin type |
| `depositAmount` | △ | 토큰 수량 (depositValueUsd와 택 1) |
| `depositValueUsd` | △ | USD 가치 (depositAmount와 택 1) |
| `multiplier` | O | 목표 레버리지 배율 |

> **주의**: `depositAmount`와 `depositValueUsd` 중 정확히 하나만 제공해야 합니다.

---

## Output: `LeveragePreview`

### Position Size

| 필드 | 타입 | 설명 | 예시 |
|------|------|------|------|
| `initialEquityUsd` | `number` | 초기 투입 금액 (USD) | `100.00` |
| `flashLoanUsdc` | `bigint` | Flash loan 금액 (USDC raw, 6 decimals) | `102000000n` |
| `flashLoanFeeUsd` | `number` | Flash loan 수수료 (USD) | `0.00` |
| `totalPositionUsd` | `number` | 총 포지션 가치 (USD) | `200.00` |
| `debtUsd` | `number` | 총 부채 (USD) | `100.00` |

### Leverage & Risk

| 필드 | 타입 | 설명 | 예시 |
|------|------|------|------|
| `effectiveMultiplier` | `number` | 실제 달성 배율 (슬리피지 반영) | `2.02` |
| `maxMultiplier` | `number` | 프로토콜 LTV 기반 최대 배율 | `3.33` |
| `assetLtv` | `number` | 프로토콜의 해당 자산 LTV (0-1) | `0.70` |
| `ltvPercent` | `number` | 포지션 LTV (%) | `50.00` |
| `liquidationThreshold` | `number` | 청산 기준선 (0-1) | `0.75` |
| `liquidationPrice` | `number` | 청산 가격 (USD/token) | `0.63` |
| `priceDropBuffer` | `number` | 청산까지 가격 하락 여유 (%) | `33.33` |

### APY & Earnings

| 필드 | 타입 | 설명 | 예시 |
|------|------|------|------|
| `supplyApyBreakdown.base` | `number` | 기본 공급 APR (0-1) | `0.0289` |
| `supplyApyBreakdown.reward` | `number` | 리워드 APR (0-1) | `0.0000` |
| `supplyApyBreakdown.total` | `number` | 총 공급 APR (0-1) | `0.0289` |
| `borrowApyBreakdown.gross` | `number` | 총 차입 APR (0-1) | `0.0545` |
| `borrowApyBreakdown.rebate` | `number` | 차입 리베이트 APR (0-1) | `0.0200` |
| `borrowApyBreakdown.net` | `number` | 순 차입 APR (0-1) | `0.0345` |
| `netApy` | `number` | 순 포지션 APY (0-1) | `0.0233` |
| `annualNetEarningsUsd` | `number` | 연간 순이익 (USD) | `2.33` |
| `swapSlippagePct` | `number` | 스왑 슬리피지 (%) | `0.00` |

---

## 내부 계산 흐름

```
previewLeverage(params)
  │
  ├── 1. resolveCoinType(depositAsset)     // 'SUI' → full coin type
  ├── 2. getAssetRiskParams(coinType)      // → ltv, liquidationThreshold, maxMultiplier
  ├── 3. Validate multiplier <= maxMultiplier
  ├── 4. getTokenPrice(coinType)           // → current USD price (7k API)
  │
  ├── 5. Position Calculation
  │     ├── initialEquityUsd = depositAmount × price
  │     ├── flashLoanUsd = equity × (multiplier - 1)
  │     ├── flashLoanUsdc = flashLoanUsd × 1e6 × 1.02  (2% buffer)
  │     ├── flashLoanFeeUsd = flashLoanUsdc × feeRate   (on-chain query)
  │     ├── totalPositionUsd = equity × multiplier
  │     ├── debtUsd = flashLoanUsd + flashLoanFeeUsd
  │     └── ltvPercent = debtUsd / totalPositionUsd × 100
  │
  ├── 6. Liquidation Calculation
  │     ├── totalCollateral = depositAmount × multiplier
  │     ├── liquidationPrice = debtUsd / (totalCollateral × liquidationThreshold)
  │     └── priceDropBuffer = (1 - liquidationPrice / currentPrice) × 100
  │
  ├── 7. APY Calculation
  │     ├── getAssetApy(depositCoinType)    // → supply APY breakdown
  │     ├── getAssetApy(USDC)               // → borrow APY breakdown
  │     ├── annualSupply = totalPosition × totalSupplyApy
  │     ├── annualBorrow = debt × netBorrowApy
  │     ├── netApy = (annualSupply - annualBorrow) / equity
  │     └── annualNetEarningsUsd = annualSupply - annualBorrow
  │
  └── 8. Swap Slippage (7k Quote)
        ├── quote(USDC → depositAsset, flashLoanUsdc)
        ├── slippage = (theoretical - actual) / theoretical × 100
        └── effectiveMultiplier = (depositAmount + actualSwapped) / depositAmount
```

---

## 데이터 소스 요약

| 데이터 | 소스 | 비고 |
|--------|------|------|
| 자산 가격 | 7k Protocol `getTokenPrice` | 실시간 DEX 집계 가격 |
| Risk Params (LTV, LT) | 각 프로토콜 어댑터 `getAssetRiskParams` | [상세 문서](../protocol-risk-params-research.md) |
| Supply/Borrow APY | 각 프로토콜 어댑터 `getAssetApy` | [상세 문서](../protocol-apy-research.md) |
| Flash Loan Fee | Scallop on-chain `FLASHLOAN_FEES_TABLE` | 현재 USDC: 0% |
| Swap Slippage | 7k Protocol `quote()` | 실시간 DEX 라우팅 |

---

## 프로토콜별 검증 결과 (2026-02-26)

### SUI 2x Leverage

| | Suilend | Navi | Scallop |
|---|---------|------|---------|
| Asset LTV | 70% | 75% | 85% |
| Liq. Threshold | 75% | 70% | 90% |
| Max Multiplier | 3.33x | 4.00x | 6.67x |
| Position LTV | 50% | 50% | 50% |
| Liq. Price | $0.63 | $0.68 | $0.53 |
| Price Drop Buffer | 33% | 29% | 44% |
| Supply APY | 2.89% | 2.97% | 2.98% |
| Borrow Net APY | 3.45% | 4.57% | 5.80% |
| **Net APY** | **2.33%** | **1.37%** | **0.15%** |

### XBTC 2x Leverage

| | Suilend | Navi | Scallop |
|---|---------|------|---------|
| Asset LTV | 60% | 67% | 75% |
| Liq. Threshold | 65% | 70% | 80% |
| Max Multiplier | 2.50x | 3.03x | 4.00x |
| Supply APY | 3.78% | 6.73% | 0.00% |
| Borrow Net APY | 3.45% | 4.57% | 5.80% |
| **Net APY** | **4.10%** | **8.88%** | **-5.80%** |

---

## Net APY 공식

```
Net APY = (totalPositionUsd × totalSupplyApy − debtUsd × netBorrowApy) / initialEquityUsd
```

레버리지가 수익을 증폭시키는 원리:
- **Supply 수익**: 전체 포지션(equity × multiplier)에 대해 supply APY 적용
- **Borrow 비용**: 부채(equity × (multiplier-1))에 대해 borrow APY 적용
- **Net APY > 0**: supply APY가 borrow APY보다 높을 때 레버리지가 수익 증폭
- **Net APY < 0**: borrow 비용이 supply 수익보다 클 때 손실 (예: Scallop XBTC)

---

## 에러 처리

| 에러 | 원인 | 해결 |
|------|------|------|
| `InvalidParameterError` | depositAmount/depositValueUsd 둘 다 or 둘 다 미제공 | 하나만 제공 |
| `InvalidParameterError` | multiplier > maxMultiplier | 배율 낮추기 |
| `UnsupportedProtocolError` | 프로토콜 미초기화 | `DefiDashSDK.create()` 호출 |
| Reserve not found | 해당 자산이 프로토콜에 미지원 | 지원 자산 확인 |

---

## 프론트엔드 사용 예시

```typescript
import { DefiDashSDK, LendingProtocol } from '@defidash/sdk';

// SDK 초기화 (앱 시작 시 1회)
const sdk = await DefiDashSDK.create(suiClient, keypair);

// 사용자가 프로토콜/자산/배율 선택 시 호출
const preview = await sdk.previewLeverage({
  protocol: LendingProtocol.Navi,
  depositAsset: 'XBTC',
  depositValueUsd: 1000,
  multiplier: 2.5,
});

// UI에 표시할 주요 값
const display = {
  totalPosition: `$${preview.totalPositionUsd.toFixed(2)}`,
  netApy: `${(preview.netApy * 100).toFixed(2)}%`,
  annualEarnings: `$${preview.annualNetEarningsUsd.toFixed(2)}`,
  liquidationPrice: `$${preview.liquidationPrice.toFixed(2)}`,
  priceDropBuffer: `${preview.priceDropBuffer.toFixed(1)}%`,
  maxLeverage: `${preview.maxMultiplier.toFixed(1)}x`,
};
```

---

## 관련 문서

- [Protocol Risk Params Research](../protocol-risk-params-research.md) — `getAssetRiskParams` 내부 구현
- [Protocol APY Research](../protocol-apy-research.md) — `getAssetApy` 내부 구현
- [Scallop Collateral vs Lending](../scallop-collateral-vs-lending.md) — Scallop 담보 구조
