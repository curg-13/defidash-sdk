/**
 * Popular coin types for quick reference
 *
 * Full coin type addresses for Sui mainnet tokens.
 * Use these constants to avoid typos and ensure consistency.
 *
 * @example
 * ```typescript
 * import { COIN_TYPES } from 'defi-dash-sdk';
 *
 * const coinType = COIN_TYPES.LBTC;
 * // "0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC"
 * ```
 */
export const COIN_TYPES = {
  // Sui
  SUI: '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI',
  // Stable Coins
  USDC: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
  USDT: '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT',
  // Ethereum
  ETH: '0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH',
  // BTC
  LBTC: '0x3e8e9423d80e1774a7ca128fccd8bf5f1f7753be658c5e645929037f7c819040::lbtc::LBTC',
  XBTC: '0x876a4b7bce8aeaef60464c11f4026903e9afacab79b9b142686158aa86560b50::xbtc::XBTC',
  // etc.
  wUSDC:
    '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN',
  wUSDT:
    '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN',
} as const;

/**
 * Token decimal places for each coin type
 *
 * Used for converting between raw amounts (bigint) and human-readable amounts.
 *
 * @example
 * ```typescript
 * import { COIN_DECIMALS, COIN_TYPES } from 'defi-dash-sdk';
 *
 * const decimals = COIN_DECIMALS[COIN_TYPES.USDC]; // 6
 * const rawAmount = BigInt(1_000_000); // 1 USDC in raw units
 * const humanAmount = Number(rawAmount) / Math.pow(10, decimals); // 1.0
 * ```
 */
export const COIN_DECIMALS: Record<string, number> = {
  [COIN_TYPES.SUI]: 9,
  [COIN_TYPES.USDC]: 6,
  [COIN_TYPES.USDT]: 6,
  [COIN_TYPES.ETH]: 8,
  [COIN_TYPES.LBTC]: 8,
  [COIN_TYPES.XBTC]: 8,
  [COIN_TYPES.wUSDC]: 6,
  [COIN_TYPES.wUSDT]: 6,
};

/**
 * Unsupported coin types for leverage/deleverage strategies
 *
 * These assets cannot be used as deposit (collateral) assets because:
 * - **USDC**: Used as flash loan asset. Cannot borrow USDC against USDC collateral.
 * - **Stablecoins**: Generally not suitable for leverage (no price appreciation expected)
 *
 * @remarks
 * The leverage strategy works by:
 * 1. Flash loan USDC → Swap to collateral → Deposit → Borrow USDC to repay
 *
 * If you deposit USDC as collateral and try to borrow USDC, the strategy fails
 * because you're essentially borrowing what you already have.
 *
 * @example
 * ```typescript
 * import { UNSUPPORTED_COIN_TYPES, COIN_TYPES } from 'defi-dash-sdk';
 *
 * function validateDepositAsset(coinType: string): boolean {
 *   return !UNSUPPORTED_COIN_TYPES.includes(coinType);
 * }
 *
 * validateDepositAsset(COIN_TYPES.LBTC); // true - can leverage
 * validateDepositAsset(COIN_TYPES.USDC); // false - cannot leverage
 * ```
 */
export const UNSUPPORTED_COIN_TYPES: string[] = [
  COIN_TYPES.USDC,
  COIN_TYPES.wUSDC,
  // Note: USDT could be added here if stablecoins are not desired for leverage
];

/**
 * Supported coin types for leverage/deleverage strategies
 *
 * These assets can be used as deposit (collateral) assets.
 * They have price volatility which makes leverage meaningful.
 *
 * @example
 * ```typescript
 * import { SUPPORTED_COIN_TYPES } from 'defi-dash-sdk';
 *
 * // Use for UI dropdown
 * const options = SUPPORTED_COIN_TYPES.map(coinType => ({
 *   value: coinType,
 *   label: getSymbolFromCoinType(coinType)
 * }));
 * ```
 */
export const SUPPORTED_COIN_TYPES: string[] = [
  COIN_TYPES.SUI,
  COIN_TYPES.LBTC,
  COIN_TYPES.XBTC,
];

/**
 * Common coin type shortcuts
 *
 * Convenience exports for the most commonly used coin types.
 */
export const USDC_COIN_TYPE = COIN_TYPES.USDC;
export const SUI_COIN_TYPE = COIN_TYPES.SUI;

/**
 * Default 7k Protocol partner ID
 *
 * Used for DEX aggregation swaps. Partners earn referral fees.
 */
export const DEFAULT_7K_PARTNER =
  '0x0cffa6f207ef1f08ff2b55d3a0ec79ec2baec55ce0eb3cfc56a48a452ba65427';
