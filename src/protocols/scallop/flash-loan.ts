import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";

/**
 * Scallop Protocol Addresses
 * Default: fetched from https://sui.apis.scallop.io/addresses/{addressId}
 * Can be overridden via constructor
 */
export interface ScallopCoreIds {
  protocolPkg: string;
  version: string;
  market: string;
  coinDecimalsRegistry: string;
  xOracle?: string;
}

export interface ScallopCoinTypes {
  [coinName: string]: string;
}

// Default addresses - using LATEST protocol package from Move Registry
const DEFAULT_CORE_IDS: ScallopCoreIds = {
  // Latest protocol package (version 17) - updated 2026-01-10
  protocolPkg:
    "0xd384ded6b9e7f4d2c4c9007b0291ef88fbfed8e709bce83d2da69de2d79d013d",
  version: "0x07871c4b3c847a0f674510d4978d5cf6f960452795e8ff6f189fd2088a3f6ac7",
  market: "0xa757975255146dc9686aa823b7838b507f315d704f428cbadad2f4ea061939d9",
  coinDecimalsRegistry:
    "0x200abe9bf19751cc566ae35aa58e2b7e4ff688fc1130f8d8909ea09bc137d668",
  xOracle: "0x93d5bf0936b71eb27255941e532fac33b5a5c7759e377b4923af0a1359ad494f",
};

const DEFAULT_COIN_TYPES: ScallopCoinTypes = {
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

export interface ScallopFlashLoanClientOptions {
  /** Override default protocol package ID */
  protocolPkg?: string;
  /** Override default version object ID */
  version?: string;
  /** Override default market object ID */
  market?: string;
  /** Additional coin types to add/override */
  coinTypes?: ScallopCoinTypes;
  /** Full override of core IDs */
  coreIds?: Partial<ScallopCoreIds>;
}

type TransactionArg = ReturnType<Transaction["splitCoins"]>;

/**
 * Custom Scallop Flash Loan Client
 *
 * Allows you to use default addresses from API or override them locally.
 * This is useful when the SDK's addresses are outdated.
 *
 * @example
 * ```ts
 * // Use defaults
 * const client = new ScallopFlashLoanClient();
 *
 * // Override protocol package (when SDK is outdated)
 * const client = new ScallopFlashLoanClient({
 *   protocolPkg: "0x...",
 * });
 * ```
 */
export class ScallopFlashLoanClient {
  private coreIds: ScallopCoreIds;
  private coinTypes: ScallopCoinTypes;

  constructor(options: ScallopFlashLoanClientOptions = {}) {
    // Merge defaults with overrides
    this.coreIds = {
      ...DEFAULT_CORE_IDS,
      ...options.coreIds,
    };

    // Allow individual overrides
    if (options.protocolPkg) this.coreIds.protocolPkg = options.protocolPkg;
    if (options.version) this.coreIds.version = options.version;
    if (options.market) this.coreIds.market = options.market;

    this.coinTypes = {
      ...DEFAULT_COIN_TYPES,
      ...options.coinTypes,
    };
  }

  /**
   * Get coin type from coin name
   */
  getCoinType(coinName: string): string {
    const coinType = this.coinTypes[coinName.toLowerCase()];
    if (!coinType) {
      throw new Error(`Unknown coin name: ${coinName}`);
    }
    return coinType;
  }

  /**
   * Get current core IDs (for debugging)
   */
  getCoreIds(): ScallopCoreIds {
    return { ...this.coreIds };
  }

  /**
   * Borrow a flash loan from Scallop
   *
   * @param tx - Sui Transaction object
   * @param amount - Amount to borrow (in smallest unit)
   * @param coinName - Coin name (e.g., 'sui', 'usdc')
   * @returns [loanCoin, receipt] - The borrowed coin and flash loan receipt
   */
  borrowFlashLoan(
    tx: Transaction,
    amount: number | bigint,
    coinName: string
  ): [TransactionArg, TransactionArg] {
    const { protocolPkg, version, market } = this.coreIds;
    const coinType = this.getCoinType(coinName);

    const result = tx.moveCall({
      target: `${protocolPkg}::flash_loan::borrow_flash_loan`,
      typeArguments: [coinType],
      arguments: [tx.object(version), tx.object(market), tx.pure.u64(amount)],
    });

    return [result[0] as any, result[1] as any];
  }

  /**
   * Repay a flash loan to Scallop
   *
   * @param tx - Sui Transaction object
   * @param coin - The coin to repay (must include fee)
   * @param receipt - The flash loan receipt (Hot Potato)
   * @param coinName - Coin name (e.g., 'sui', 'usdc')
   */
  repayFlashLoan(
    tx: Transaction,
    coin: TransactionArg,
    receipt: TransactionArg,
    coinName: string
  ): void {
    const { protocolPkg, version, market } = this.coreIds;
    const coinType = this.getCoinType(coinName);

    tx.moveCall({
      target: `${protocolPkg}::flash_loan::repay_flash_loan`,
      typeArguments: [coinType],
      arguments: [
        tx.object(version),
        tx.object(market),
        coin as any,
        receipt as any,
      ],
    });
  }

  /**
   * Calculate flash loan fee (0.05% = 5 basis points)
   */
  static calculateFee(amount: bigint): bigint {
    const FEE_RATE = 5n;
    const FEE_DENOMINATOR = 10000n;
    return (amount * FEE_RATE) / FEE_DENOMINATOR;
  }

  /**
   * Fetch latest addresses from Scallop API
   * Use this to update the client when SDK is outdated
   */
  static async fetchFromAPI(
    addressId: string = "67c44a103fe1b8c454eb9699"
  ): Promise<ScallopCoreIds> {
    const res = await fetch(
      `https://sui.apis.scallop.io/addresses/${addressId}`
    );
    const data = await res.json();

    return {
      protocolPkg: data.mainnet.core.packages.protocol.id,
      version: data.mainnet.core.version,
      market: data.mainnet.core.market,
      coinDecimalsRegistry: data.mainnet.core.coinDecimalsRegistry,
      xOracle: data.mainnet.core.oracles?.xOracle,
    };
  }
}

export default ScallopFlashLoanClient;
