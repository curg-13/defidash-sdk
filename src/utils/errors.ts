/**
 * DeFi Dash SDK - Error Classes
 *
 * Standardized, type-safe error types for the SDK.
 * All custom errors extend DefiDashError for easy catching.
 *
 * @module errors
 *
 * @example Type-safe error handling
 * ```typescript
 * import { UnknownAssetError, SDKNotInitializedError } from 'defi-dash-sdk';
 *
 * try {
 *   await sdk.leverage({ ... });
 * } catch (error) {
 *   if (error instanceof UnknownAssetError) {
 *     console.error('Invalid asset specified');
 *   } else if (error instanceof SDKNotInitializedError) {
 *     console.error('Initialize SDK first');
 *   } else {
 *     console.error('Unexpected error:', error);
 *   }
 * }
 * ```
 */

/**
 * Base error class for all SDK errors
 *
 * Extend this class to create custom SDK errors.
 *
 * @example
 * ```typescript
 * if (error instanceof DefiDashError) {
 *   // Handle all SDK errors
 *   console.error(`SDK Error [${error.name}]: ${error.message}`);
 * }
 * ```
 */
export class DefiDashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefiDashError";
  }
}

/**
 * Error thrown when SDK is not initialized
 */
export class SDKNotInitializedError extends DefiDashError {
  constructor() {
    super("SDK not initialized. Call initialize() first.");
    this.name = "SDKNotInitializedError";
  }
}

/**
 * Error thrown when an unsupported protocol is requested
 */
export class UnsupportedProtocolError extends DefiDashError {
  constructor(protocol: string) {
    super(`Protocol "${protocol}" is not supported`);
    this.name = "UnsupportedProtocolError";
  }
}

/**
 * Error thrown when an unknown asset is referenced
 */
export class UnknownAssetError extends DefiDashError {
  constructor(asset: string) {
    super(`Unknown asset: "${asset}"`);
    this.name = "UnknownAssetError";
  }
}

/**
 * Error thrown when a position is not found
 */
export class PositionNotFoundError extends DefiDashError {
  constructor(protocol?: string) {
    super(
      protocol
        ? `No position found on ${protocol}`
        : "No position found"
    );
    this.name = "PositionNotFoundError";
  }
}

/**
 * Error thrown when trying to deleverage but no debt exists
 */
export class NoDebtError extends DefiDashError {
  constructor() {
    super("No debt to repay. Use withdraw instead.");
    this.name = "NoDebtError";
  }
}

/**
 * Error thrown when invalid parameters are provided
 */
export class InvalidParameterError extends DefiDashError {
  constructor(message: string) {
    super(`Invalid parameter: ${message}`);
    this.name = "InvalidParameterError";
  }
}

/**
 * Error thrown when insufficient balance for operation
 */
export class InsufficientBalanceError extends DefiDashError {
  constructor(required: string, available: string, asset: string = "SUI") {
    super(
      `Insufficient ${asset} balance. Required: ${required}, Available: ${available}`
    );
    this.name = "InsufficientBalanceError";
  }
}

/**
 * Error thrown when a transaction dry run fails
 */
export class DryRunFailedError extends DefiDashError {
  constructor(reason?: string) {
    super(reason ? `Dry run failed: ${reason}` : "Dry run failed");
    this.name = "DryRunFailedError";
  }
}

/**
 * Error thrown when a transaction execution fails
 */
export class TransactionFailedError extends DefiDashError {
  constructor(reason?: string) {
    super(reason ? `Transaction failed: ${reason}` : "Transaction failed");
    this.name = "TransactionFailedError";
  }
}

/**
 * Error thrown when keypair is required but not provided
 */
export class KeypairRequiredError extends DefiDashError {
  constructor() {
    super("Keypair required for this operation");
    this.name = "KeypairRequiredError";
  }
}

/**
 * Error thrown when coin type validation fails
 */
export class InvalidCoinTypeError extends DefiDashError {
  constructor(coinType: string) {
    super(`Invalid coin type: "${coinType}"`);
    this.name = "InvalidCoinTypeError";
  }
}
