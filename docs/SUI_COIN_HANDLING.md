# SUI Coin Handling in Leverage Strategy

레버리지 전략에서 SUI와 non-SUI 토큰을 처리할 때 필요한 `mergeCoins` 로직에 대한 설명입니다.

## 문제 상황

Sui 블록체인에서 **SUI 토큰**은 특별한 케이스입니다:

- SUI는 **gas 비용 지불에도 사용**되는 네이티브 토큰
- 트랜잭션 실행 시 `tx.gas`에서 gas fee가 자동 차감됨
- 일반 토큰처럼 coin object를 직접 조회해서 merge하면 **gas 비용 지불용 SUI가 없어짐**

## 에러 증상

```
❌ ERROR: No valid gas coins found for the transaction.
```

또는

```
❌ InsufficientCoinBalance in command N
```

## 해결 방법

### SUI 토큰인 경우

```typescript
if (isSui) {
  // tx.gas에서 필요한 양만 split → gas 비용용 SUI 남김
  const [userDeposit] = tx.splitCoins(tx.gas, [BigInt(DEPOSIT_AMOUNT)]);

  // 스왑으로 받은 SUI와 merge
  tx.mergeCoins(userDeposit, [swappedAsset]);

  depositCoin = userDeposit;
}
```

**핵심 포인트:**

1. `tx.gas`에서 `splitCoins`로 필요한 금액만 분리
2. 나머지 SUI는 gas 비용으로 자동 사용됨
3. split된 coin에 swapped asset을 merge

### Non-SUI 토큰인 경우

```typescript
else {
  // 일반 토큰: 지갑에서 coin object 조회
  const userCoins = await suiClient.getCoins({
    owner: userAddress,
    coinType: normalizedDepositCoin,
  });

  // 첫 번째 coin을 primary로 설정
  const primaryCoin = tx.object(userCoins.data[0].coinObjectId);

  // 여러 coin이 있으면 하나로 merge
  if (userCoins.data.length > 1) {
    const otherCoins = userCoins.data.slice(1).map(c => tx.object(c.coinObjectId));
    tx.mergeCoins(primaryCoin, otherCoins);
  }

  // 스왑으로 받은 자산과 merge
  tx.mergeCoins(primaryCoin, [swappedAsset]);

  depositCoin = primaryCoin;
}
```

**핵심 포인트:**

1. `getCoins`로 지갑 내 해당 토큰의 모든 coin object 조회
2. 여러 개면 하나로 merge (Sui는 UTXO 모델)
3. swapped asset과 최종 merge

## Suilend SDK 참고

Suilend SDK의 `depositIntoObligation` 메서드도 동일한 패턴을 사용:

```typescript
// 출처: @suilend/sdk client.ts
const [sendCoin] = transaction.splitCoins(
  isSui(coinType)
    ? transaction.gas  // SUI인 경우 gas에서 split
    : transaction.object(mergeCoin.coinObjectId),
  [value],
);
```

## 요약

| 토큰 타입   | 처리 방식                                      |
| ----------- | ---------------------------------------------- |
| **SUI**     | `tx.gas`에서 `splitCoins` → gas 비용 자동 확보 |
| **Non-SUI** | `getCoins`로 조회 → `mergeCoins`로 통합        |

---

## References

- [Suilend SDK - client.ts](https://github.com/suilend/suilend-fe-public/blob/main/sdk/src/client.ts#L829)
- [Sui PTB Documentation](https://docs.sui.io/concepts/transactions/prog-txn-blocks)
