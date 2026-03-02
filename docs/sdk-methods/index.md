# DefiDash SDK Methods

> SDK Public API 전체 목록. 각 메서드의 상세 문서는 링크 참조.

---

## 초기화

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `create` (static) | `(suiClient, keypairOrAddress, options?) → Promise<DefiDashSDK>` | 팩토리 메서드로 SDK 인스턴스 생성 + 초기화 |

```typescript
// Node.js
const sdk = await DefiDashSDK.create(suiClient, keypair);

// Browser
const sdk = await DefiDashSDK.create(suiClient, account.address);
```

> `constructor`와 `initialize()`는 `private`입니다. 반드시 `create()`를 사용하세요.

---

## Strategy (Core)

| 메서드 | 시그니처 | 설명 | 상세 |
|--------|----------|------|------|
| `buildLeverageTransaction` | `(tx, BrowserLeverageParams) → Promise<void>` | 레버리지 TX 빌드 (Browser/Node.js 공용) | [leverage.md](./leverage.md) |
| `buildDeleverageTransaction` | `(tx, BrowserDeleverageParams) → Promise<void>` | 디레버리지 TX 빌드 (Browser/Node.js 공용) | [deleverage.md](./deleverage.md) |
| `previewLeverage` | `(params) → Promise<LeveragePreview>` | 레버리지 포지션 미리보기 (TX 실행 없음) | [preview-leverage.md](./preview-leverage.md) |
| `findBestLeverageRoute` | `(FindBestRouteParams) → Promise<LeverageRouteResult>` | 전 프로토콜 최적 레버리지 경로 탐색 | [find-best-leverage-route.md](./find-best-leverage-route.md) |

---

## Position / Portfolio

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `getPosition` | `(protocol: LendingProtocol) → Promise<PositionInfo \| null>` | 특정 프로토콜의 현재 포지션 조회 |
| `getOpenPositions` | `() → Promise<Array<{ protocol, position }>>` | 전 프로토콜에서 오픈된 포지션만 반환 (병렬 조회) |
| `getAggregatedPortfolio` | `() → Promise<AccountPortfolio[]>` | 전 프로토콜 포트폴리오 집계 (APY/수익률 포함) |

### `getPosition()` — 단일 프로토콜 포지션

```typescript
const position = await sdk.getPosition(LendingProtocol.Navi);
if (position) {
  // 전체 supply/borrow 목록
  for (const s of position.supplies) {
    console.log(`  Supply: ${s.symbol} $${s.valueUsd.toFixed(2)}`);
  }
  for (const b of position.borrows) {
    console.log(`  Borrow: ${b.symbol} $${b.valueUsd.toFixed(2)}`);
  }
  // Primary collateral/debt (USD 가치 기준 최대)
  console.log(`  Primary collateral: ${position.collateral.symbol}`);
  console.log(`  Primary debt: ${position.debt.symbol}`);
  console.log(`  Net: $${position.netValueUsd.toFixed(2)}`);
}
```

#### `PositionInfo` 필드

| 필드 | 타입 | 설명 |
|------|------|------|
| `collateral` | `AssetPosition` | Primary collateral (USD 가치 최대 supply) |
| `debt` | `AssetPosition` | Primary debt (USD 가치 최대 borrow) |
| `supplies` | `AssetPosition[]` | 전체 supply 포지션 (dust 포함) |
| `borrows` | `AssetPosition[]` | 전체 borrow 포지션 |
| `netValueUsd` | `number` | 순자산 (총 supply - 총 borrow) |
| `healthFactor?` | `number` | 건전성 비율 (> 1 안전, < 1 청산 위험) |

### `getOpenPositions()` — 오픈 포지션 필터링

```typescript
const positions = await sdk.getOpenPositions();

for (const { protocol, position } of positions) {
  console.log(`${protocol}: $${position.netValueUsd.toFixed(2)}`);
}
```

- 포지션이 없는 프로토콜은 제외됨
- 전략 실행 전 포지션 확인 용도

### `getAggregatedPortfolio()` — 대시보드용 포트폴리오

```typescript
const portfolios = await sdk.getAggregatedPortfolio();

for (const p of portfolios) {
  console.log(`${p.protocol}: $${p.netValueUsd.toFixed(2)} (APY: ${p.netApy}%)`);
}
```

- **항상 3개 프로토콜 반환** (포지션 없어도 기본값)
- APY, 연간 수익 추정 등 대시보드 표시용 데이터 포함
- 개별 포지션마다 `apy`, `rewardsApy` 포함

---

## Execution

| 메서드 | 시그니처 | 환경 | 설명 |
|--------|----------|------|------|
| `dryRun` | `(tx: Transaction) → Promise<StrategyResult>` | Node.js / Browser | TX 시뮬레이션. 가스 추정값 반환 |
| `execute` | `(tx: Transaction) → Promise<StrategyResult>` | Node.js only | TX 서명 + 실행. 가스 최적화 포함 |

실행 로직은 `src/utils/execution.ts`의 standalone 함수 (`dryRunTransaction`, `executeTransaction`)에 위임.

```typescript
// Build → Dry run → Execute
const tx = new Transaction();
tx.setSender(address);
await sdk.buildLeverageTransaction(tx, params);

const dryResult = await sdk.dryRun(tx);
console.log(`Estimated gas: ${dryResult.gasUsed}`);

// Execute (Node.js only — requires keypair)
const result = await sdk.execute(tx);
console.log(`TX: ${result.txDigest}`);
```

---

## Utility

| 메서드 | 시그니처 | 설명 |
|--------|----------|------|
| `getTokenPrice` | `(asset: string) → Promise<number>` | 자산 USD 가격 조회 (7k Protocol) |
| `getSuiClient` | `() → SuiClient` | 내부 SuiClient 인스턴스 반환 |
| `getUserAddress` | `() → string` | 현재 유저 주소 반환 |

---

## 지원 프로토콜

| 프로토콜 | enum 값 | 비고 |
|----------|---------|------|
| Suilend | `LendingProtocol.Suilend` | |
| Navi | `LendingProtocol.Navi` | |
| Scallop | `LendingProtocol.Scallop` | |

---

## 에러 타입

| 에러 | 발생 조건 |
|------|-----------|
| `SDKNotInitializedError` | `create()` 미호출 |
| `UnsupportedProtocolError` | 미지원 프로토콜 지정 |
| `UnknownAssetError` | 미인식 자산 심볼 |
| `InvalidParameterError` | 잘못된 파라미터 (depositAmount/depositValueUsd 동시 제공 등) |
| `PositionNotFoundError` | 디레버리지 시 포지션 없음 |
| `NoDebtError` | 디레버리지 시 부채 없음 |
| `KeypairRequiredError` | `execute()` 호출 시 keypair 미제공 |
| `InvalidCoinTypeError` | 잘못된 coin type 형식 |

---

## 파일 구조

```
src/
  sdk.ts                    ← DefiDashSDK 클래스 (public API)
  index.ts                  ← 공개 export 정의
  strategies/
    leverage.ts             ← buildLeverageTransaction
    deleverage.ts           ← buildDeleverageTransaction
    leverage-preview.ts     ← previewLeverage
    leverage-route.ts       ← findBestLeverageRoute
  utils/
    execution.ts            ← dryRunTransaction, executeTransaction
    gas.ts                  ← 가스 계산 유틸
    format.ts               ← formatUnits, parseUnits
    coin.ts                 ← normalizeCoinType, resolveCoinType
    errors.ts               ← SDK 에러 클래스
    calculations.ts         ← fromRawUnits, calculateLiquidationMetrics
```
