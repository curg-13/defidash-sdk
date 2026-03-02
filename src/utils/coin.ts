import { InvalidCoinTypeError, UnknownAssetError } from "./errors";
import { COIN_DECIMALS, COIN_TYPES } from "../types/constants";

/**
 * Look up the decimal places for a coin type.
 *
 * Uses the SDK-level COIN_DECIMALS map with a configurable fallback
 * (default 8, which covers most Sui assets).
 *
 * @param coinType - Normalized full coin type string
 * @param fallback - Decimal places to return if coin type is unknown (default: 8)
 */
export function getDecimals(coinType: string, fallback = 8): number {
  return COIN_DECIMALS[coinType] ?? fallback;
}

/**
 * Normalizes a Sui coin type address to ensure consistent formatting.
 * Pads the package address to 64 characters and ensures 0x prefix.
 *
 * @param coinType - The coin type string (e.g., "0x2::sui::SUI")
 * @returns The normalized coin type with padded address
 * @throws {InvalidCoinTypeError} If coinType is not in `package::module::Type` format
 *
 * @example
 * normalizeCoinType("0x2::sui::SUI")
 * // "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI"
 */
export function normalizeCoinType(coinType: string): string {
  const parts = coinType.split('::');
  if (parts.length !== 3) {
    throw new InvalidCoinTypeError(coinType);
  }
  let pkg = parts[0].replace('0x', '');
  pkg = pkg.padStart(64, '0');
  return `0x${pkg}::${parts[1]}::${parts[2]}`;
}

/**
 * Resolve an asset symbol (e.g. "SUI", "LBTC") or full coin type to a normalized coin type.
 *
 * @param asset - Symbol string or full coin type (containing "::")
 * @returns Normalized coin type
 * @throws {UnknownAssetError} If symbol is not recognized
 */
export function resolveCoinType(asset: string): string {
  if (asset.includes('::')) {
    return normalizeCoinType(asset);
  }

  const upperSymbol = asset.toUpperCase();
  const coinType = COIN_TYPES[upperSymbol as keyof typeof COIN_TYPES];
  if (coinType) {
    return normalizeCoinType(coinType);
  }

  throw new UnknownAssetError(asset);
}

