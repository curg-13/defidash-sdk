/**
 * Scallop Protocol Mainnet Addresses
 * Source: https://sui.apis.scallop.io/addresses/66f8e7ed9bb9e07fdfb86bbb
 * Updated: 2025-01-04
 */

export const SCALLOP_ADDRESSES = {
  core: {
    version:
      "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7",
    market:
      "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9",
    protocolPkg:
      "0x83bbe0b3985c5e3857803e2678899b03f3c4a31be75006ab03faf268c014ce41",
    coinDecimalsRegistry:
      "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668",
  },
} as const;

// Coin type mappings
export const SCALLOP_COIN_TYPES: Record<string, string> = {
  sui: "0x2::sui::SUI",
  usdc: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC",
  wusdc:
    "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN",
  wusdt:
    "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN",
  weth: "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN",
  wbtc: "0x027792d9fed7f9844eb4839566001bb6f6cb4804f66aa2da6fe1ee242d896881::coin::COIN",
  cetus:
    "0x06864a6f921804860930db6ddbe2e16acdf8504495ea7481637a1c8b9a8fe54b::cetus::CETUS",
  afsui:
    "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI",
  hasui:
    "0xbde4ba4c2e274a60ce15c1cfff9e5c42e41654ac8b6d906a57efa4bd3c29f47d::hasui::HASUI",
  vsui: "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT",
  sca: "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA",
  deep: "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP",
  fud: "0x76cb819b01abed502bee8a702b4c2d547532c12f25001c9dea795a5e631c26f1::fud::FUD",
};

// Decimals for each coin
export const SCALLOP_COIN_DECIMALS: Record<string, number> = {
  sui: 9,
  usdc: 6,
  wusdc: 6,
  wusdt: 6,
  weth: 8,
  wbtc: 8,
  cetus: 9,
  afsui: 9,
  hasui: 9,
  vsui: 9,
  sca: 9,
  deep: 6,
  fud: 5,
};

/**
 * Get coin type from coin name
 */
export function getCoinType(coinName: string): string {
  const coinType = SCALLOP_COIN_TYPES[coinName.toLowerCase()];
  if (!coinType) {
    throw new Error(`Unknown coin name: ${coinName}`);
  }
  return coinType;
}

/**
 * Get decimals for a coin
 */
export function getCoinDecimals(coinName: string): number {
  return SCALLOP_COIN_DECIMALS[coinName.toLowerCase()] ?? 9;
}
