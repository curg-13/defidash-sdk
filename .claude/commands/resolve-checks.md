# /resolve-checks - Code Review Check Resolver

Scan code for `Check ❌` markers, understand the comments, implement the fix, and update the marker to `Check ✅`.

## Usage

```bash
/resolve-checks                     # Scan all modified files (git diff)
/resolve-checks src/strategies/     # Scan specific directory
/resolve-checks src/leverage.ts     # Scan specific file
```

## What It Does

1. **Find Check Markers** - Search for `// Check ❌` patterns in specified files
2. **Read Context** - Parse the Korean/English comments below the marker explaining what needs to be done
3. **Implement Fix** - Apply the suggested change based on the comment
4. **Update Marker** - Change `❌` to `✅` after implementation
5. **Report** - Summarize what was changed and why

## Marker Format

```typescript
// Check ❌
// 한글 또는 영어로 작성된 리뷰 코멘트
// 여러 줄도 가능
const problematicCode = ...;
```

After resolution:

```typescript
// Check ✅
// [RESOLVED] 한글 또는 영어로 작성된 리뷰 코멘트
// 실제로 어떻게 수정했는지 간단히 추가
const fixedCode = ...;
```

## Example

**Before:**
```typescript
// Check ❌
// 어차피 내부적으로 알아서 계산할텐데 우리가 이걸 여기서 한번 더 할 필요가 있나?
// 그냥 flashLoanUsdc 값만 넘겨주고 내부에서 계산하게 하는게 맞지 않을까?
const flashLoanFee = ScallopFlashLoanClient.calculateFee(flashLoanUsdc);
const repaymentAmount = flashLoanUsdc + flashLoanFee;
```

**After:**
```typescript
// Check ✅
// [RESOLVED] Flash loan fee는 repayFlashLoan 내부에서 자동 계산됨
// flashLoanUsdc만 전달하고 fee 계산 로직은 ScallopFlashLoanClient에 위임
const repaymentAmount = flashLoanUsdc; // Fee calculated internally by repayFlashLoan
```

## Resolution Actions

When you see a `Check ❌`, you should:

1. **Understand the problem** - Read ALL comment lines below the marker
2. **Analyze the suggestion** - Determine what change is being requested
3. **Implement the fix** - Make the actual code change
4. **Update the marker** - Change `❌` → `✅` and add `[RESOLVED]` prefix
5. **Add resolution note** - Briefly explain what was done

## Common Check Types

| Comment Pattern | Action |
|-----------------|--------|
| "이걸 여기서 할 필요가 있나?" | Move logic to appropriate location or remove |
| "상수화 시키는게 낫지 않을까?" | Extract to constants file |
| "테스트 케이스를 만들어보자" | Create test file |
| "sdk 레벨에서 관리" | Move to SDK-level types/constants |
| "configurable from param" | Add parameter to function signature |

## Output Format

After processing, report:

```
## Resolved Checks Summary

### File: src/strategies/leverage.ts

1. **Line 285** - Flash loan fee calculation
   - Problem: Redundant fee calculation
   - Fix: Delegated to ScallopFlashLoanClient internally
   - Status: ✅ Resolved

2. **Line 203** - Magic string 'usdc'
   - Problem: Hardcoded string
   - Fix: Extracted to FLASH_LOAN_ASSET constant
   - Status: ✅ Resolved

### Remaining Checks: 0 ❌
```

## Notes

- Always read the FULL comment block (may span multiple lines)
- Comments can be in Korean or English
- If unsure about implementation, ask for clarification
- Don't remove the original comment - mark it as resolved
- Run `git diff` after to verify changes
