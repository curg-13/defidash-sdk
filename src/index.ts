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
 * const sdk = await DefiDashSDK.create(suiClient, keypair);
 *
 * // Build leverage transaction
 * const tx = new Transaction();
 * tx.setSender(address);
 * await sdk.buildLeverageTransaction(tx, {
 *   protocol: LendingProtocol.Suilend,
 *   depositAsset: 'LBTC',
 *   depositAmount: '0.001',
 *   multiplier: 2.0,
 * });
 *
 * // Node.js: execute via SDK
 * const result = await sdk.execute(tx);
 *
 * // Browser: execute via wallet adapter
 * await signAndExecute({ transaction: tx });
 * ```
 */

// Main SDK
export { DefiDashSDK } from './sdk';

// Enums & Constants
export {
  LendingProtocol,
  USDC_COIN_TYPE,
  SUI_COIN_TYPE,
  COIN_TYPES,
} from './types';

// Types — Strategy
export type {
  StrategyResult,
  LeveragePreview,
  FindBestRouteParams,
  LeverageRoute,
  LeverageRouteResult,
  AssetLeverageInfo,
} from './types';

// Types — Position & Portfolio
export type {
  AssetPosition,
  PositionInfo,
  Position,
  AccountPortfolio,
  MarketAsset,
} from './types';

// Types — Config
export type {
  SDKOptions,
  BrowserLeverageParams,
  BrowserDeleverageParams,
} from './types';

// Utilities (frontend-facing only)
export { formatUnits, parseUnits } from './utils/format';
export { normalizeCoinType } from './utils/coin';
export {
  DefiDashError,
  SDKNotInitializedError,
  InvalidParameterError,
  InvalidCoinTypeError,
} from './utils/errors';
