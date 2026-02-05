/**
 * Test cases for normalizeCoinType utility function
 *
 * Run with: npx ts-node scripts/tests/test_normalize_coin_type.ts
 */

import { normalizeCoinType } from '../../src/utils/coin';
import { COIN_TYPES } from '../../src/types/constants';

interface TestCase {
  input: string;
  expected: string;
  description: string;
}

const testCases: TestCase[] = [
  // SUI coin type tests
  {
    input: '0x2::sui::SUI',
    expected:
      '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
    description: 'SUI short address should be padded to 64 chars',
  },
  {
    input: COIN_TYPES.SUI,
    expected: COIN_TYPES.SUI,
    description: 'SUI full address should remain unchanged',
  },

  // LBTC coin type tests
  {
    input: COIN_TYPES.LBTC,
    expected: COIN_TYPES.LBTC,
    description: 'LBTC full address should remain unchanged',
  },
  {
    input:
      '0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC',
    expected:
      '0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC',
    description: 'LBTC already normalized should remain unchanged',
  },

  // XBTC coin type tests
  {
    input: COIN_TYPES.XBTC,
    expected: COIN_TYPES.XBTC,
    description: 'XBTC full address should remain unchanged',
  },

  // USDC coin type tests
  {
    input: COIN_TYPES.USDC,
    expected: COIN_TYPES.USDC,
    description: 'USDC full address should remain unchanged',
  },

  // ETH coin type tests
  {
    input: COIN_TYPES.ETH,
    expected: COIN_TYPES.ETH,
    description: 'ETH full address should remain unchanged',
  },

  // Edge cases
  {
    input: 'invalid',
    expected: 'invalid',
    description: 'Invalid format should return as-is',
  },
  {
    input: '0xabc::module::Type',
    expected:
      '0x0000000000000000000000000000000000000000000000000000000000000abc::module::Type',
    description: 'Short address should be padded',
  },
];

function runTests(): void {
  console.log('🧪 Testing normalizeCoinType utility function\n');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  for (const testCase of testCases) {
    const result = normalizeCoinType(testCase.input);
    const isPass = result === testCase.expected;

    if (isPass) {
      console.log(`✅ PASS: ${testCase.description}`);
      passed++;
    } else {
      console.log(`❌ FAIL: ${testCase.description}`);
      console.log(`   Input:    ${testCase.input}`);
      console.log(`   Expected: ${testCase.expected}`);
      console.log(`   Got:      ${result}`);
      failed++;
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }

  console.log('\n✅ All tests passed!');
}

runTests();
