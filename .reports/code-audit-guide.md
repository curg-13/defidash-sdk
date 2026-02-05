# SDK 코드 오딧 가이드

## 📋 오딧 목적
- NPM 배포 전 전체 코드 품질 확인
- 비효율적이거나 불필요한 코드 제거
- 보안 취약점 확인
- 타입 안정성 검증

---

## 🗺️ 전체 구조 이해 (5분)

### 1단계: 디렉토리 구조 파악
```bash
tree -L 2 -I 'node_modules|dist' src/
```

**핵심 디렉토리:**
```
src/
├── index.ts                 # Public API (사용자가 import하는 것)
├── sdk.ts                   # 메인 SDK 클래스
├── protocols/               # 프로토콜별 adapter
│   ├── base-adapter.ts      # 공통 base class
│   ├── suilend/
│   ├── navi/
│   └── scallop/
├── strategies/              # 전략 로직 (leverage, deleverage)
├── types/                   # TypeScript 타입 정의
└── utils/                   # 유틸리티 함수들
```

### 2단계: 엔트리 포인트 확인
1. **package.json** - `"main"` 필드 확인 → `dist/index.js`
2. **src/index.ts** - 뭘 export하는지 확인
3. **tsconfig.json** - TypeScript 설정 확인

---

## 📊 우선순위별 리뷰 순서

### Priority 1: Public API (30분)
**사용자가 직접 사용하는 인터페이스 - 가장 중요!**

#### ✅ 체크리스트:
- [ ] **src/index.ts** - export된 것들이 실제로 필요한가?
- [ ] **src/types/config.ts** - 사용자 facing 타입들이 명확한가?
- [ ] **src/types/strategy.ts** - 파라미터 타입이 합리적인가?

**확인 사항:**
```typescript
// ❌ 나쁜 예: 너무 많이 export
export * from './internal/helpers'  // 내부 구현 노출

// ✅ 좋은 예: 필요한 것만 export
export { DefiDashSDK } from './sdk'
export { LendingProtocol } from './types'
```

**Golang과 비교:**
- Go: `package` 레벨에서 대문자로 시작하는 것만 public
- TS: `export` 키워드로 명시적으로 public 지정

---

### Priority 2: 메인 SDK 클래스 (45분)
**핵심 비즈니스 로직**

#### ✅ 파일: src/sdk.ts

**확인 사항:**

1. **초기화 로직**
```typescript
// 중복 초기화 방지되는가?
async initialize() {
  if (this.initialized) return;  // ✅ Good
  // ...
}
```

2. **에러 핸들링**
```typescript
// ❌ 나쁜 예: Generic error
throw new Error("Something went wrong")

// ✅ 좋은 예: Specific error
throw new InvalidParameterError("depositAmount must be positive")
```

3. **불필요한 'as any' 체크**
```bash
grep -n "as any" src/sdk.ts
```
- 각 'as any'가 정말 필요한지 확인
- 가능하면 제거하고 proper typing 사용

4. **메모리 누수 가능성**
```typescript
// ❌ 나쁜 예: 계속 쌓이는 데이터
private transactions: Transaction[] = []
someMethod() {
  this.transactions.push(tx)  // 계속 쌓임!
}

// ✅ 좋은 예: 정리 메커니즘
clearPendingState() {
  this.pendingStates.clear()
}
```

**Golang과 비교:**
- Go: defer로 cleanup
- TS: 명시적으로 cleanup 메서드 호출 필요

---

### Priority 3: Protocol Adapters (1시간)
**각 프로토콜 통합 코드**

#### ✅ 파일들:
- src/protocols/suilend/adapter.ts
- src/protocols/navi/adapter.ts
- src/protocols/scallop/adapter.ts
- src/protocols/base-adapter.ts

**확인 사항:**

1. **코드 중복**
```bash
# 중복 코드 찾기
grep -r "ensureInitialized" src/protocols/
```
- Base class로 옮길 수 있는 공통 로직이 있는가?

2. **External SDK 의존성**
```typescript
// ❌ 나쁜 예: External SDK를 직접 노출
async withdraw() {
  return await externalSdk.withdraw()  // 타입이 any?
}

// ✅ 좋은 예: 내부 타입으로 변환
async withdraw(): Promise<Coin> {
  const result = await externalSdk.withdraw()
  return this.convertToCoin(result)
}
```

3. **Decimal 처리 (중요!)**
```typescript
// ❌ 나쁜 예: Number로 변환 (precision loss)
const amount = Number(bigIntValue) / 1e9

// ✅ 좋은 예: bigint 유지
const amount = bigIntValue
const humanReadable = Number(amount) / 1e9  // display only
```

**Golang과 비교:**
- Go: `big.Int`, `big.Float` 사용
- TS: `bigint` 사용, Number 변환은 display용으로만

---

### Priority 4: Strategies (45분)
**비즈니스 로직 - Leverage/Deleverage**

#### ✅ 파일들:
- src/strategies/leverage.ts
- src/strategies/deleverage.ts

**확인 사항:**

1. **Gas 최적화 로직**
```typescript
// ✅ 확인: Dryrun → Calculate → Execute 패턴
const dryRunResult = await dryRun()
const optimizedGas = calculate(dryRunResult)
const result = await execute(optimizedGas)
```

2. **트랜잭션 원자성**
```typescript
// Flash loan → Swap → Deposit → Borrow → Repay
// ✅ 모든 단계가 하나의 PTB에 있는가?
// ❌ 여러 개의 separate transactions로 나뉘어 있으면 안 됨
```

3. **수학 계산 정확도**
```typescript
// ❌ 나쁜 예: Floating point arithmetic
const fee = amount * 0.0008

// ✅ 좋은 예: BigInt arithmetic
const fee = (amount * 8n) / 10000n
```

4. **Buffer 계산이 합리적인가?**
```typescript
// Flash loan buffer: 0.1% → 합리적
// Swap slippage: 1% → 확인 필요 (너무 큰가?)
// Borrow buffer: 0.5% → 합리적
```

---

### Priority 5: Utils & Types (30분)
**유틸리티 및 타입 정의**

#### ✅ 파일들:
- src/utils/index.ts
- src/utils/gas.ts
- src/utils/errors.ts
- src/types/*.ts

**확인 사항:**

1. **불필요한 유틸리티**
```bash
# 사용되지 않는 함수 찾기
grep -r "export function oldHelper" src/
# 이 함수가 어디서도 import되지 않으면 삭제
```

2. **타입 정의 중복**
```bash
# 같은 타입이 여러 파일에 정의되어 있는가?
grep -r "interface PositionInfo" src/
```

3. **Magic Numbers**
```typescript
// ❌ 나쁜 예
const buffer = amount * 1.2  // 1.2가 뭐지?

// ✅ 좋은 예
const GAS_BUFFER_PERCENT = 20
const buffer = (amount * (100n + BigInt(GAS_BUFFER_PERCENT))) / 100n
```

**Golang과 비교:**
- Go: const로 상수 정의
- TS: const나 enum 사용

---

## 🔍 비효율/불필요한 코드 찾기

### 체크리스트:

#### 1. Dead Code (죽은 코드)
```bash
# 사용되지 않는 exports
npx ts-prune

# 사용되지 않는 dependencies
npx depcheck
```

#### 2. 중복 코드
```bash
# 중복된 함수 찾기
grep -r "function calculateFee" src/
grep -r "normalizeCoinType" src/
```

**기준:**
- 같은 로직이 3번 이상 반복되면 → 공통 함수로 추출
- 2번만 반복되면 → 상황에 따라 판단

#### 3. Over-engineering
```typescript
// ❌ 나쁜 예: 불필요한 추상화
abstract class BaseStrategy {
  abstract execute(): Promise<Result>
}
class LeverageStrategy extends BaseStrategy { ... }
// 실제로는 leverage strategy만 있고 다른 strategy는 없음

// ✅ 좋은 예: 필요한 만큼만
export async function buildLeverageTransaction() { ... }
```

#### 4. 과도한 주석
```typescript
// ❌ 나쁜 예: 코드를 그대로 설명
// Increment i by 1
i++

// ✅ 좋은 예: Why를 설명
// Add 2% buffer because flash loan fee accrues during transaction
const buffer = amount * 1.02
```

#### 5. Console.log 제거
```bash
grep -r "console.log" src/
# Production code에서는 모두 제거해야 함
# 필요하면 proper logging library 사용
```

---

## 🔒 보안 체크리스트

### 1. Secrets 노출 (Critical!)
```bash
# Private key나 secrets가 코드에 하드코딩되어 있는가?
grep -ri "private.*key\|secret" src/
grep -ri "suiprivkey" src/

# ✅ 환경변수로만 받아야 함
const secretKey = process.env.SECRET_KEY
```

### 2. Input Validation
```typescript
// ✅ 모든 user input이 validate되는가?
if (multiplier < 1 || multiplier > 10) {
  throw new InvalidParameterError("multiplier must be between 1 and 10")
}
```

### 3. External Call Safety
```typescript
// ✅ External SDK calls이 try-catch로 감싸져 있는가?
try {
  const result = await externalSdk.someMethod()
} catch (error) {
  throw new ExternalServiceError("Failed to call external service", error)
}
```

---

## 📦 배포 전 최종 체크

### 1. Build 확인
```bash
npm run build
# dist/ 디렉토리 확인
ls -la dist/
```

### 2. Package.json 검증
```json
{
  "name": "defi-dash-sdk",
  "version": "0.1.3-alpha.4",  // ✅ 버전 올렸는가?
  "main": "dist/index.js",     // ✅ 맞는 경로인가?
  "types": "dist/index.d.ts",  // ✅ 타입 정의 있는가?
  "files": ["dist", "README.md"],  // ✅ 불필요한 파일 포함 안 됐나?
}
```

### 3. Dependencies 정리
```bash
# Unused dependencies
npx depcheck

# Outdated dependencies
npm outdated
```

### 4. 불필요한 파일 제거
```bash
# .gitignore 확인
cat .gitignore

# NPM에 포함될 파일 확인
npm pack --dry-run
```

---

## 🎯 Golang 개발자를 위한 TypeScript 핵심 차이점

### 1. Error Handling
```go
// Go
result, err := doSomething()
if err != nil {
    return nil, err
}
```

```typescript
// TypeScript
try {
  const result = await doSomething()
} catch (error) {
  throw new CustomError("Failed", error)
}
```

### 2. Null Safety
```go
// Go
var ptr *int  // nil if not initialized
if ptr != nil {
    use(*ptr)
}
```

```typescript
// TypeScript
let value: number | null = null
if (value !== null) {
  use(value)
}
// 또는 optional chaining
value?.toString()
```

### 3. Interfaces vs Types
```go
// Go - Interface는 method만
type Reader interface {
    Read(p []byte) (n int, err error)
}
```

```typescript
// TypeScript - Interface는 shape을 정의
interface Position {
  collateral: AssetPosition
  debt: AssetPosition
  netValueUsd: number
}
```

### 4. Async/Await
```go
// Go - Goroutines
go func() {
    result := doSomething()
}()
```

```typescript
// TypeScript - Promises
const result = await doSomething()

// Parallel execution
const [result1, result2] = await Promise.all([
  doSomething1(),
  doSomething2()
])
```

---

## ⏱️ 예상 시간 배분

| 단계 | 시간 | 우선순위 |
|------|------|----------|
| 구조 이해 | 5분 | ⭐⭐⭐ |
| Public API | 30분 | ⭐⭐⭐ |
| SDK 클래스 | 45분 | ⭐⭐⭐ |
| Protocol Adapters | 1시간 | ⭐⭐⭐ |
| Strategies | 45분 | ⭐⭐⭐ |
| Utils & Types | 30분 | ⭐⭐ |
| 보안 체크 | 30분 | ⭐⭐⭐ |
| 배포 준비 | 15분 | ⭐⭐⭐ |
| **총** | **4시간** | |

---

## 🚀 오딧 후 액션 아이템 템플릿

오딧하면서 발견한 것들을 기록:

```markdown
## Critical (배포 전 필수 수정)
- [ ]

## High (배포 전 수정 권장)
- [ ]

## Medium (다음 버전에서 수정)
- [ ]

## Low (개선 사항)
- [ ]

## 삭제할 파일/코드
- [ ]
```

---

## 📝 오딧 시작 명령어

```bash
# 1. 전체 구조 파악
tree -L 3 -I 'node_modules|dist' src/

# 2. 타입 체크
npm run build

# 3. 불필요한 exports 찾기
npx ts-prune

# 4. 불필요한 dependencies 찾기
npx depcheck

# 5. Security check
grep -ri "secret\|private.*key\|console.log" src/

# 6. 'as any' 남용 체크
grep -rn "as any" src/ | wc -l

# 7. TODO/FIXME 확인
grep -rn "TODO\|FIXME" src/
```

---

**다음 단계:**
1. 이 가이드를 따라 오딧 시작
2. 발견한 이슈들을 액션 아이템으로 정리
3. Critical/High 이슈 수정
4. 다시 빌드 & 테스트
5. NPM 배포

Good luck! 🎉
