# Sui Leverage Lending Script

Sui 블록체인에서 **레버리지 롱 포지션**을 구축하기 위한 스크립트 모음입니다. Flash Loan, Swap Aggregator, Lending Protocol을 조합하여 단일 트랜잭션(PTB) 내에서 레버리지 전략을 실행합니다.

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Leverage Strategy (PTB)                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐   │
│  │  1. Flash Loan  │───▶│  2. Swap        │───▶│  3. Lending     │   │
│  │   Component     │    │   Aggregator    │    │   Protocol      │   │
│  ├─────────────────┤    ├─────────────────┤    ├─────────────────┤   │
│  │  현재: Scallop  │    │  현재: 7k       │    │  현재: Suilend  │   │
│  │  (확장 가능)    │    │  (확장 가능)    │    │  (확장 가능)    │   │
│  └─────────────────┘    └─────────────────┘    └─────────────────┘   │
│         │                                              │              │
│         └────────────── Borrow to Repay ◀──────────────┘              │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

**핵심 로직:**

1. **Flash Loan** - USDC를 무담보로 빌림 (Scallop)
2. **Swap** - USDC를 담보 자산(LBTC 등)으로 스왑 (7k Aggregator)
3. **Deposit** - 스왑된 자산을 렌딩 프로토콜에 담보로 예치 (Suilend)
4. **Borrow** - 담보를 바탕으로 USDC를 빌려 Flash Loan 상환 (Suilend)

---

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Setup Environment

```bash
# .env.example을 .env로 복사
cp .env.example .env

# .env 파일을 열고 SECRET_KEY 설정
# SECRET_KEY=your_private_key_here (base64 encoded)
```

> ⚠️ **중요**: `.env` 파일에는 프라이빗 키가 포함되므로 절대 커밋하지 마세요!

### 3. Test Configuration

`.env.public` 파일에서 테스트 파라미터를 설정합니다:

```bash
# 레버리지 전략 설정 예시
LEVERAGE_DEPOSIT_COIN_TYPE=0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC
LEVERAGE_DEPOSIT_AMOUNT=1101
LEVERAGE_MULTIPLIER=1.5
```

---

## Test Scripts

테스트 스크립트는 1~4번으로 분리되어 있으며, 각 컴포넌트를 개별적으로 테스트할 수 있습니다.

### Component Tests (1~3번)

| Prefix  | Script                           | Command                        | Description                         |
| ------- | -------------------------------- | ------------------------------ | ----------------------------------- |
| **1\_** | `1_scallop_flash-loan-custom.ts` | `npm run test:flash-loan`      | Scallop Flash Loan 빌리고 바로 상환 |
| **1\_** | `1_scallop_query-fees.ts`        | `npm run test:fees`            | Flash Loan 수수료 조회              |
| **2\_** | `2_suilend_deposit.ts`           | `npm run test:suilend-deposit` | Suilend에 담보 예치                 |
| **2\_** | `2_suilend_borrow.ts`            | `npm run test:suilend-borrow`  | Suilend에서 자산 대출               |
| **3\_** | `3_7k_swap_dryrun.ts`            | `npm run test:swap`            | 7k Aggregator 스왑 (시뮬레이션)     |
| **3\_** | `3_7k_swap_exec.ts`              | `npm run test:swap-exec`       | 7k Aggregator 스왑 (실행)           |

### Final Leverage Strategy (4번)

4번 스크립트는 1~3번 컴포넌트를 **단일 Programmable Transaction Block (PTB)**으로 통합한 최종 레버리지 전략입니다.

| Script                          | Command                      | Description                        |
| ------------------------------- | ---------------------------- | ---------------------------------- |
| `4_leverage_strategy_dryrun.ts` | `npm run test:leverage`      | 레버리지 전략 시뮬레이션 (Dry Run) |
| `4_leverage_strategy_exec.ts`   | `npm run test:leverage-exec` | 레버리지 전략 실제 실행            |

#### 4번 스크립트 실행 흐름

```
1. Flash Loan (Scallop)     → USDC 빌림
2. Swap (7k Aggregator)     → USDC → LBTC 스왑
3. Deposit (Suilend)        → LBTC 담보 예치
4. Borrow (Suilend)         → USDC 대출
5. Repay Flash Loan         → Flash Loan 상환
```

---

## Extending for Other Protocols

이 프로젝트는 3가지 컴포넌트가 분리되어 있어, 다른 프로토콜로 쉽게 확장할 수 있습니다.

### Component Interfaces

각 컴포넌트는 다음 인터페이스를 따르면 됩니다:

#### 1. Flash Loan Component

```typescript
// 현재 구현: src/lib/scallop.ts
interface IFlashLoan {
  borrowFlashLoan(tx: Transaction, amount: bigint, coinName: string): [coin, receipt];
  repayFlashLoan(tx: Transaction, coin: any, receipt: any, coinName: string): void;
}
```

**확장 가능한 프로토콜:**

- NAVI Protocol
- Bucket Protocol
- 기타 Flash Loan 지원 프로토콜

#### 2. Swap Aggregator Component

```typescript
// 현재 구현: @7kprotocol/sdk-ts
interface ISwapAggregator {
  quote(params: { amountIn: string; coinTypeIn: string; coinTypeOut: string }): Promise<Quote[]>;
  swap(params: { quote: Quote; coinIn: Coin; tx: Transaction }): Promise<Coin>;
}
```

**확장 가능한 프로토콜:**

- Aftermath Finance
- Cetus Protocol
- Turbos Finance

#### 3. Lending Protocol Component

```typescript
// 현재 구현: @suilend/sdk
interface ILending {
  deposit(coin: Coin, coinType: string, obligationCapId: string, tx: Transaction): void;
  borrow(obligationCapId: string, obligationId: string, coinType: string, amount: string, tx: Transaction): Promise<Coin[]>;
}
```

**확장 가능한 프로토콜:**

- Scallop Lending
- NAVI Lending
- Bucket Protocol

### Adding New Protocol Support

새로운 프로토콜을 추가하려면:

1. **Wrapper 클래스 생성**: `src/lib/` 디렉토리에 새 프로토콜 래퍼 생성
2. **인터페이스 구현**: 위 인터페이스에 맞게 메서드 구현
3. **테스트 스크립트 작성**: `tests/` 디렉토리에 개별 테스트 추가
4. **통합**: `4_leverage_strategy_*.ts`에서 새 프로토콜 조합 테스트

예시 (NAVI Flash Loan 추가):

```typescript
// src/lib/navi.ts
export class NaviFlashLoanClient implements IFlashLoan {
  borrowFlashLoan(tx: Transaction, amount: bigint, coinName: string) {
    // NAVI SDK를 사용한 Flash Loan 구현
  }

  repayFlashLoan(tx: Transaction, coin: any, receipt: any, coinName: string) {
    // NAVI SDK를 사용한 상환 구현
  }
}
```

---

## Project Structure

```
leverage-lending-script/
├── src/
│   ├── lib/
│   │   ├── scallop.ts      # Flash Loan wrapper
│   │   └── const.ts        # 상수 및 Reserve 정보
│   └── index.ts
├── tests/
│   ├── 1_scallop_*.ts      # Flash Loan 테스트
│   ├── 2_suilend_*.ts      # Lending 테스트
│   ├── 3_7k_*.ts           # Swap 테스트
│   └── 4_leverage_*.ts     # 통합 레버리지 테스트
├── .env                    # 비밀키 (git ignore)
├── .env.example            # 환경변수 템플릿
├── .env.public             # 공개 설정값
└── package.json
```

---

## References

- **Flash Loan (Scallop)**: https://github.com/scallop-io/sui-scallop-sdk
- **Swap Aggregator (7k)**: https://github.com/7k-ag/7k-sdk-ts
- **Lending Protocol (Suilend)**: https://docs.suilend.fi/ecosystem/suilend-sdk-guide/getting-started-with-suilend-sdk

---

## License

ISC
