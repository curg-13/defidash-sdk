/**
 * DeFi Dash SDK
 *
 * Multi-protocol DeFi SDK for Sui blockchain integrating leverage strategies,
 * flash loans, and lending protocols.
 *
 * @module defi-dash-sdk
 *
 * @example
 * ```typescript
 * import { DefiDashSDK, LendingProtocol } from 'defi-dash-sdk';
 *
 * const sdk = new DefiDashSDK();
 * await sdk.initialize(suiClient, keypair);
 *
 * // Leverage strategy
 * const result = await sdk.leverage({
 *   protocol: LendingProtocol.Suilend,
 *   depositAsset: 'LBTC',
 *   depositAmount: '0.001',
 *   multiplier: 2.0,
 *   dryRun: true
 * });
 * ```
 */

// Main SDK
export { DefiDashSDK } from "./sdk";

// Types, Interfaces, Enums, and Constants
export {
  // Enums
  LendingProtocol,
  type PositionSide,

  // Position types
  type AssetPosition,
  type PositionInfo,
  type Position,
  type AccountPortfolio,
  type MarketAsset,

  // Strategy types
  type LeverageParams,
  type DeleverageParams,
  type StrategyResult,
  type LeveragePreview,

  // Config types
  type SDKOptions,
  type BrowserLeverageParams,
  type BrowserDeleverageParams,

  // Protocol interface
  type ILendingProtocol,
  type MarketReserve,

  // Constants
  USDC_COIN_TYPE,
  SUI_COIN_TYPE,
  DEFAULT_7K_PARTNER,
  COIN_TYPES,
} from "./types";

// Strategy Builders (for advanced usage)
export {
  buildLeverageTransaction,
  calculateLeveragePreview,
  buildDeleverageTransaction,
  calculateDeleverageEstimate,
} from "./strategies";

// Utilities
export * from "./utils";

// Flash Loan
export { ScallopFlashLoanClient } from "./protocols/scallop/flash-loan";

// Protocol-specific data
export {
  SUILEND_RESERVES,
  getReserveByCoinType,
  getReserveBySymbol,
} from "./protocols/suilend/constants";
