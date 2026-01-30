/**
 * DeFi Dash SDK - Type Definitions
 *
 * Central export for all types, interfaces, enums, and constants
 */

// Enums and common types
export { LendingProtocol, type PositionSide } from "./common";

// Position and portfolio types
export type {
  AssetPosition,
  PositionInfo,
  Position,
  AccountPortfolio,
  MarketAsset,
} from "./position";

// Strategy types
export type {
  LeverageParams,
  DeleverageParams,
  StrategyResult,
  LeveragePreview,
} from "./strategy";

// Configuration types
export type {
  SDKOptions,
  BrowserLeverageParams,
  BrowserDeleverageParams,
} from "./config";

// Constants
export {
  USDC_COIN_TYPE,
  SUI_COIN_TYPE,
  DEFAULT_7K_PARTNER,
  COIN_TYPES,
} from "./constants";

// Protocol interface and types
export type { ILendingProtocol, MarketReserve } from "./protocol";
