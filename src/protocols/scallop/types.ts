/**
 * Scallop Protocol - Type Definitions
 *
 * Types, interfaces, and constants for Scallop protocol integration
 */

/**
 * Scallop address types (fetched dynamically from SDK)
 */
export interface ScallopCoreAddresses {
  protocolPkg: string;
  version: string;
  market: string;
  coinDecimalsRegistry: string;
  xOracle: string;
  obligationAccessStore: string;
}

export interface ScallopBorrowIncentiveAddresses {
  pkg: string;
  config: string;
  incentivePools: string;
  incentiveAccounts: string;
}

export interface ScallopVeScaAddresses {
  config: string;
  treasury: string;
  table: string;
  subsTable: string;
  subsWhitelist: string;
}

export interface ScallopAddresses {
  core: ScallopCoreAddresses;
  borrowIncentive: ScallopBorrowIncentiveAddresses;
  vesca: ScallopVeScaAddresses;
}

/**
 * Scallop obligation structure
 */
export interface ScallopObligation {
  id: string;
  keyId: string;
  locked: boolean;
  collaterals: Array<{
    coinType: string;
    amount: bigint;
  }>;
  debts: Array<{
    coinType: string;
    amount: bigint;
  }>;
}

/**
 * Coin type mappings for Scallop
 *
 * Maps full coin types to Scallop's internal coin names.
 * Required for operations like deposit, withdraw, borrow, repay.
 */
export const COIN_TYPE_MAP: Record<string, string> = {
  // Native SUI
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI':
    'sui',
  // Stablecoins
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC':
    'usdc',
  '0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN':
    'wusdc',
  '0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN':
    'wusdt',
  // Wrapped assets
  '0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN':
    'weth',
  '0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN':
    'wbtc',
  // BTC variants
  '0xaafb102dd0902f5055cadecd687fb5b71ca82ef0e0285d90afde828ec58ca96b::btc::BTC':
    'xbtc',
  '0x5d89b60f87e587b54e5f87886356b0af23ce41dff56e506c6a47e8125c965a9d::lbtc::LBTC':
    'lbtc',
  // Protocol tokens
  '0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS':
    'cetus',
  '0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA':
    'sca',
  '0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP':
    'deep',
  '0x76cb819b01abed502bee8a702b4c2d547532c12f25001c9dea795a5e631c26f1::fud::FUD':
    'fud',
  // Liquid staking tokens
  '0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI':
    'afsui',
  '0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI':
    'hasui',
  '0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT':
    'vsui',
  // Spring SUI
  '0x83556891f4a0f233ce7b05cfe7f957d4020492a34f5405b2cb9377d060bef4bf::spring_sui::SPRING_SUI':
    'ssui',
};

/**
 * Reverse map: Scallop coin name → full coin type
 */
export const COIN_NAME_TO_TYPE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(COIN_TYPE_MAP).map(([type, name]) => [name, type])
);

/**
 * Get Scallop coin name from full coin type
 */
export function getCoinName(coinType: string): string {
  const normalized = coinType.toLowerCase();
  const name = COIN_TYPE_MAP[coinType] || COIN_TYPE_MAP[normalized];
  if (!name) {
    throw new Error(`Unknown Scallop coin type: ${coinType}`);
  }
  return name;
}

/**
 * Get full coin type from Scallop coin name
 */
export function getCoinType(coinName: string): string {
  const type = COIN_NAME_TO_TYPE_MAP[coinName.toLowerCase()];
  if (!type) {
    throw new Error(`Unknown Scallop coin name: ${coinName}`);
  }
  return type;
}

// Export legacy alias for backwards compatibility
export { COIN_TYPE_MAP as SCALLOP_COIN_TYPE_MAP };
