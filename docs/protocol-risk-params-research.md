# Protocol Risk Parameters Research & Implementation Guide

> **대상 독자**: DefiDash SDK 기여자 및 프로토콜 통합 연구자
> **목적**: 각 lending 프로토콜에서 `getAssetRiskParams`를 구현하는 방법, 온체인 데이터 구조, 파싱 로직을 문서화
> **최종 검증**: 2026-02-26 (mainnet live data)

---

## 구현 목표

`previewLeverage`가 레버리지 포지션의 최대 배율(Max Multiplier)과 청산 리스크를 계산하려면 각 프로토콜의 다음 네 가지 값이 필요합니다:

| 필드                   | 설명                                                   |
| ---------------------- | ------------------------------------------------------ |
| `ltv`                  | Loan-to-Value ratio (0-1). 담보 대비 최대 차입 가능 비율 |
| `liquidationThreshold` | 청산 기준선 (0-1). 이 비율을 초과하면 청산 대상         |
| `liquidationBonus`     | 청산 보너스 (0-1). 청산자에게 주어지는 인센티브          |
| `maxMultiplier`        | 최대 레버리지 배율: `1 / (1 - ltv)`                    |

> **핵심 원칙**: `maxMultiplier`는 LTV에서 파생되는 계산값입니다. 각 프로토콜의 온체인 LTV를 정확하게 조회하는 것이 핵심입니다.

---

## Interface 정의

```typescript
// src/types/protocol.ts
export interface AssetRiskParams {
  ltv: number;                  // 0-1
  liquidationThreshold: number; // 0-1
  liquidationBonus: number;     // 0-1
  maxMultiplier: number;        // 1 / (1 - ltv)
}
```

모든 프로토콜 어댑터는 `ILendingProtocol` 인터페이스의 `getAssetRiskParams(coinType: string): Promise<AssetRiskParams>`를 구현합니다.

---

## Fallback 전략

모든 프로토콜이 모든 자산을 지원하지는 않습니다. 지원하지 않는 자산에 대해서는 보수적인 기본값을 반환합니다:

```typescript
const FALLBACK: AssetRiskParams = {
  ltv: 0.5,                  // 50%
  liquidationThreshold: 0.6, // 60%
  liquidationBonus: 0.05,    // 5%
  maxMultiplier: 2.0,        // 2x
};
```

> **참고**: Fallback 값은 의도적으로 보수적입니다. 실제 온체인 값보다 낮은 LTV를 반환하여 사용자가 과도한 레버리지를 취하는 것을 방지합니다.

---

## 1. Suilend

**파일**: [`src/protocols/suilend/adapter.ts`](../src/protocols/suilend/adapter.ts)

### 데이터 소스

Suilend SDK의 `SuilendClient`가 초기화 시 lending market 데이터를 메모리에 로드합니다:

```
SuilendClient.initialize(suiClient, LENDING_MARKET_ID)
  → this.client.lendingMarket.reserves[]
    → reserve.config.element
      ├── openLtvPct (u8: 0-100)
      ├── closeLtvPct (u8: 0-100)
      └── liquidationBonusBps (u16: basis points)
```

### 온체인 데이터 형식

| 필드                  | Move 타입 | 범위    | 변환            |
| -------------------- | --------- | ------- | --------------- |
| `openLtvPct`         | `u8`      | 0-100   | `/ 100`         |
| `closeLtvPct`        | `u8`      | 0-100   | `/ 100`         |
| `liquidationBonusBps`| `u16`     | 0-10000 | `/ 10000`       |

### 구현 로직

```typescript
async getAssetRiskParams(coinType: string): Promise<AssetRiskParams> {
  const normalized = normalizeCoinType(coinType);

  // reserves 배열에서 해당 coinType의 reserve를 찾음
  const reserve = this.client.lendingMarket.reserves.find(
    (r) => normalizeCoinType(r.coinType.name) === normalized,
  );
  if (!reserve) return FALLBACK;

  const config = reserve.config.element;
  if (!config) return FALLBACK;

  const ltv = Number(config.openLtvPct) / 100;
  const liquidationThreshold = Number(config.closeLtvPct) / 100;
  const liquidationBonus = Number(config.liquidationBonusBps) / 10000;
  const maxMultiplier = ltv > 0 ? 1 / (1 - ltv) : 1;

  return { ltv, liquidationThreshold, liquidationBonus, maxMultiplier };
}
```

### 특이사항

- **RPC 호출 없음**: `initialize()` 시점에 이미 모든 reserve 데이터를 메모리에 로드
- **openLtvPct vs closeLtvPct**: Suilend은 포지션 오픈 시 LTV(`open`)와 청산 판단 시 LTV(`close`)를 구분
- **항상 threshold >= ltv**: Suilend에서는 `closeLtvPct >= openLtvPct` 보장

### 검증된 값 (2026-02-26)

| 자산 | LTV  | Liq. Threshold | Liq. Bonus | Max Mult |
|------|------|----------------|------------|----------|
| SUI  | 70%  | 75%            | 3%         | 3.33x    |
| LBTC | 60%  | 65%            | 3%         | 2.50x    |
| XBTC | 60%  | 65%            | 3%         | 2.50x    |

---

## 2. Navi

**파일**: [`src/protocols/navi/adapter.ts`](../src/protocols/navi/adapter.ts)

### 데이터 소스

Navi SDK의 `getPools()` API가 초기화 시 pool 목록을 메모리에 로드합니다:

```
NAVISDKClient.getPools({ env: "prod" })
  → this.pools[]
    → pool
      ├── ltv (다중 형식: RAY / percentage / decimal)
      ├── liquidationThreshold (다중 형식)
      └── liquidationBonus (다중 형식)
```

### 온체인 데이터 형식 — 다중 형식 주의!

Navi는 값을 세 가지 형식 중 하나로 반환할 수 있습니다:

| 형식            | 예시 (65% LTV)                  | 판별 조건       | 변환     |
| --------------- | ------------------------------- | --------------- | -------- |
| RAY (10^27)     | `650000000000000000000000000`   | `value > 1e20`  | `/ 1e27` |
| Percentage      | `65`                            | `value > 1`     | `/ 100`  |
| Decimal         | `0.65`                          | `value <= 1`    | 그대로   |

### 구현 로직

```typescript
async getAssetRiskParams(coinType: string): Promise<AssetRiskParams> {
  const pool = this.getPool(coinType);  // normalizeCoinType으로 매칭
  if (!pool) return FALLBACK;

  // 값 파싱 — 형식 자동 감지
  let ltv = 0.5;
  if (pool.ltv) {
    const ltvValue = parseFloat(pool.ltv.toString());
    if (ltvValue > 1e20) ltv = ltvValue / 1e27;       // RAY
    else if (ltvValue > 1) ltv = ltvValue / 100;       // Percentage
    else ltv = ltvValue;                                // Decimal
  }

  // liquidationThreshold, liquidationBonus도 동일한 패턴으로 파싱
  // ...

  const maxMultiplier = ltv > 0 && ltv < 1 ? 1 / (1 - ltv) : 1;
  return { ltv, liquidationThreshold, liquidationBonus, maxMultiplier };
}
```

### 특이사항

- **RPC 호출 없음**: `initialize()` 시점에 REST API로 pool 데이터를 메모리에 로드
- **다중 형식 처리 필수**: Navi SDK가 반환하는 값의 형식이 일관되지 않으므로, 값의 크기에 따라 형식을 추론
- **threshold < ltv 가능**: Navi는 `liquidationThreshold`를 LTV와 독립적으로 설정. SUI의 경우 LTV(75%) > LT(70%)인 경우가 존재
- **pool 매칭**: `pool.coinType` 또는 `pool.suiCoinType` 둘 다 확인

### 검증된 값 (2026-02-26)

| 자산 | LTV  | Liq. Threshold | Liq. Bonus | Max Mult |
|------|------|----------------|------------|----------|
| SUI  | 75%  | 70%            | 5%         | 4.00x    |
| LBTC | 55%  | 70%            | 5%         | 2.22x    |
| XBTC | 67%  | 70%            | 5%         | 3.03x    |

> **주의**: Navi SUI는 `LTV(75%) > liquidationThreshold(70%)`입니다. 이는 Navi의 독특한 설계이며, 테스트에서 `threshold >= ltv` 단언을 하지 않는 이유입니다.

---

## 3. Scallop

**파일**: [`src/protocols/scallop/adapter.ts`](../src/protocols/scallop/adapter.ts)

### 데이터 소스

Scallop은 SDK의 `queryMarket()`에 `isLayerZeroAsset` 내부 크래시 버그가 있어, **온체인 `risk_models` 테이블을 직접 조회**합니다:

```
SuiClient.getObject(Market ID)
  → Market.risk_models.fields.table.fields.id.id
    → riskModelTableId

SuiClient.getDynamicFieldObject(riskModelTableId, TypeName key)
  → RiskModel
    ├── collateral_factor (FixedPoint32)
    ├── liquidation_factor (FixedPoint32)
    └── liquidation_discount (FixedPoint32)
```

### 온체인 데이터 구조

```
Market Object (0xa757975255146dc9686aa823b7838b507f315d704f428571571275f1461f13e2)
  └── risk_models: Table<TypeName, RiskModel>
        └── Dynamic Fields
              ├── Key: 0x1::type_name::TypeName { name: "0002::sui::SUI" }
              │   └── Value: RiskModel
              │         ├── collateral_factor: FixedPoint32 { value: u64 }
              │         ├── liquidation_factor: FixedPoint32 { value: u64 }
              │         └── liquidation_discount: FixedPoint32 { value: u64 }
              ├── Key: TypeName { name: "876a...::xbtc::XBTC" }
              │   └── Value: RiskModel { ... }
              └── (LBTC는 존재하지 않음 → FALLBACK)
```

### FixedPoint32 파싱

Move의 `FixedPoint32`는 `u64` 값을 `2^32`로 나누어 소수점을 표현합니다:

```typescript
const DIVISOR = 2 ** 32;  // 4294967296
const ltv = Number(rm.collateral_factor?.fields?.value) / DIVISOR;
// 예: SUI → 3650722201 / 4294967296 ≈ 0.85 (85%)
```

| 필드                    | Move 타입       | 파싱               |
| ----------------------- | --------------- | ------------------ |
| `collateral_factor`     | `FixedPoint32`  | `value / 2^32`     |
| `liquidation_factor`    | `FixedPoint32`  | `value / 2^32`     |
| `liquidation_discount`  | `FixedPoint32`  | `value / 2^32`     |

### 구현 로직

```typescript
async getAssetRiskParams(coinType: string): Promise<AssetRiskParams> {
  const normalized = normalizeCoinType(coinType);

  // Step 1: Market 오브젝트에서 risk_models 테이블 ID 조회
  const marketObj = await this.suiClient.getObject({
    id: this.coreAddresses.market,
    options: { showContent: true },
  });
  const marketFields = (marketObj.data?.content as any)?.fields;
  const riskModelTableId =
    marketFields?.risk_models?.fields?.table?.fields?.id?.id;
  if (!riskModelTableId) return FALLBACK;

  // Step 2: Dynamic field 조회 — key는 "0x" prefix 제거 필요
  const coinTypeKey = normalized.startsWith("0x")
    ? normalized.slice(2)
    : normalized;

  const resp = await this.suiClient.getDynamicFieldObject({
    parentId: riskModelTableId,
    name: {
      type: "0x1::type_name::TypeName",
      value: { name: coinTypeKey },
    },
  });
  const rm = (resp.data?.content as any)?.fields?.value?.fields;
  if (!rm) return FALLBACK;

  // Step 3: FixedPoint32 파싱
  const DIVISOR = 2 ** 32;
  const ltv = Number(rm.collateral_factor?.fields?.value) / DIVISOR;
  const liquidationThreshold =
    Number(rm.liquidation_factor?.fields?.value) / DIVISOR;
  const liquidationBonus =
    Number(rm.liquidation_discount?.fields?.value) / DIVISOR;

  if (isNaN(ltv) || ltv <= 0 || ltv >= 1) return FALLBACK;

  const maxMultiplier = 1 / (1 - ltv);
  return { ltv, liquidationThreshold, liquidationBonus, maxMultiplier };
}
```

### 특이사항

- **매 호출 시 2회 RPC 호출**: `getObject()` + `getDynamicFieldObject()` — Suilend/Navi와 달리 메모리 캐시 없음
- **SDK 버그 우회**: Scallop SDK v2.3.14-rc.1의 `queryMarket()`은 `isLayerZeroAsset` 내부에서 크래시. v2.4.0은 ESM-only로 CJS 프로젝트와 호환 불가
- **Coin type 주소 매핑 필수**: SDK의 `COIN_TYPES` 주소와 Scallop 온체인 주소가 다를 수 있음. [`src/protocols/scallop/types.ts`](../src/protocols/scallop/types.ts)의 `COIN_TYPE_MAP`에 양쪽 주소를 모두 등록해야 함
- **LBTC 미지원**: Scallop의 `risk_models`에 LBTC 항목이 없어 FALLBACK 반환
- **"0x" prefix 제거**: `getDynamicFieldObject`의 TypeName 키에는 `0x` prefix 없이 사용해야 함

### Coin Type 주소 매핑 이슈

Scallop은 같은 자산에 대해 여러 주소를 사용합니다:

```typescript
// src/protocols/scallop/types.ts — COIN_TYPE_MAP
// Scallop-native 주소 (온체인 risk_models 테이블에서 사용)
'0xaafb102d...::btc::BTC': 'xbtc',
'0x5d89b60f...::lbtc::LBTC': 'lbtc',

// SDK canonical 주소 (COIN_TYPES.XBTC, COIN_TYPES.LBTC)
'0x876a4b7b...::xbtc::XBTC': 'xbtc',
'0x3e8e9423...::lbtc::LBTC': 'lbtc',
```

`getAssetRiskParams`는 `normalizeCoinType()`으로 입력을 정규화한 후 직접 온체인 테이블을 조회하므로, SDK canonical 주소로도 올바르게 동작합니다.

### 검증된 값 (2026-02-26)

| 자산 | LTV  | Liq. Threshold | Liq. Bonus | Max Mult | 비고               |
|------|------|----------------|------------|----------|--------------------|
| SUI  | 85%  | 90%            | 4%         | 6.67x    | 온체인 직접 조회    |
| LBTC | 50%  | 60%            | 5%         | 2.00x    | FALLBACK (미지원)  |
| XBTC | 75%  | 80%            | 2%         | 4.00x    | 온체인 직접 조회    |

---

## 프로토콜 간 비교

### 조회 방식 비교

| 구분             | Suilend                    | Navi                      | Scallop                        |
| ---------------- | -------------------------- | ------------------------- | ------------------------------ |
| **데이터 소스**   | SDK 메모리 캐시            | SDK REST API 메모리 캐시   | 온체인 직접 RPC 조회            |
| **초기화 시 RPC** | O (SuilendClient.init)     | O (getPools)              | O (address fetch만)            |
| **조회 시 RPC**   | X                          | X                         | O (2회/조회)                   |
| **LTV 형식**      | u8 (0-100)                 | 다중 (RAY/percent/decimal)| FixedPoint32 (u64/2^32)        |
| **SDK 의존성**    | `@suilend/sdk`             | `navi-sdk`                | 직접 RPC (SDK 버그 우회)       |

### maxMultiplier 비교 (SUI 기준)

```
Scallop:  LTV 85% → maxMultiplier = 1/(1-0.85) = 6.67x  (가장 높음)
Navi:     LTV 75% → maxMultiplier = 1/(1-0.75) = 4.00x
Suilend:  LTV 70% → maxMultiplier = 1/(1-0.70) = 3.33x  (가장 낮음)
```

> **레버리지 전략 관점**: Scallop이 가장 높은 레버리지를 허용하지만, 그만큼 청산 리스크도 높습니다.

---

## 테스트 방법

### 단위 테스트 실행

```bash
npx vitest run src/__tests__/getAssetRiskParams.test.ts
```

### 테스트 구조

각 프로토콜별로 다음을 검증합니다:

1. **`it.each(SUPPORTED_COIN_TYPES)`**: 모든 지원 자산에 대해 유효한 범위 검증
   - `0 < ltv < 1`
   - `0 < liquidationThreshold <= 1`
   - `0 < liquidationBonus < 1`
   - `maxMultiplier ≈ 1/(1-ltv)` (tolerance 0.01)
   - `maxMultiplier > 1`

2. **자산별 특화 테스트**: 온체인 실제 값과의 범위 비교
   - Suilend SUI: LTV 50-85%, LBTC/XBTC: LTV 40-80%
   - Navi LBTC: LTV ~55%, LT ~70% / XBTC: LTV ~67%, LT ~70%
   - Scallop SUI: LTV 70-90% / LBTC: FALLBACK / XBTC: LTV 60-85%

3. **Fallback 검증**: 지원하지 않는 자산은 FALLBACK 값을 반환하는지 확인

---

## 새로운 프로토콜 추가 시

1. `ILendingProtocol` 인터페이스의 `getAssetRiskParams` 구현
2. 프로토콜의 온체인 데이터 형식 파악 (LTV가 어떤 형식으로 저장되는지)
3. 지원하지 않는 자산에 대해 FALLBACK 반환
4. `getAssetRiskParams.test.ts`에 프로토콜별 describe 블록 추가
5. 이 문서에 프로토콜 섹션 추가

---

## 알려진 이슈

| 이슈 | 상태 | 설명 |
|------|------|------|
| Scallop SDK `queryMarket()` 크래시 | 우회됨 | v2.3.14-rc.1의 `isLayerZeroAsset` 내부 오류. 직접 RPC로 우회 |
| Scallop SDK v2.4.0 ESM 호환 불가 | 미해결 | v2.4.0은 `"type": "module"` → CJS 프로젝트에서 import 실패 |
| Scallop LBTC 미지원 | 확인됨 | risk_models 테이블에 LBTC 항목 없음. FALLBACK 반환 |
| Navi LTV > LT (SUI) | 확인됨 | Navi의 의도적 설계. threshold < ltv 가능 |
