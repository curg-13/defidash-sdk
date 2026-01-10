import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

/**
 * Scallop Core IDs for protocol interaction
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

// Latest protocol package (version 17) - updated 2026-01-10
const DEFAULT_CORE_IDS: ScallopCoreIds = {
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

type TransactionArg = ReturnType<Transaction["splitCoins"]>;

export interface ScallopBuilderOptions {
  client: SuiClient;
  signer?: Ed25519Keypair;
  coreIds?: Partial<ScallopCoreIds>;
  coinTypes?: ScallopCoinTypes;
}

/**
 * Scallop Transaction Block - similar to SDK's ScallopTxBlock
 *
 * Wraps a @mysten/sui Transaction and provides Scallop-specific methods.
 */
export class ScallopTxBlock {
  /** The underlying @mysten/sui Transaction */
  public readonly txBlock: Transaction;

  private coreIds: ScallopCoreIds;
  private coinTypes: ScallopCoinTypes;

  constructor(
    tx?: Transaction,
    coreIds?: Partial<ScallopCoreIds>,
    coinTypes?: ScallopCoinTypes
  ) {
    this.txBlock = tx || new Transaction();
    this.coreIds = { ...DEFAULT_CORE_IDS, ...coreIds };
    this.coinTypes = { ...DEFAULT_COIN_TYPES, ...coinTypes };
  }

  /**
   * Set the sender address for this transaction
   */
  setSender(sender: string): this {
    this.txBlock.setSender(sender);
    return this;
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
   * Borrow a flash loan from Scallop
   *
   * @param amount - Amount to borrow (in smallest unit)
   * @param coinName - Coin name (e.g., 'sui', 'usdc')
   * @returns [loanCoin, receipt] - The borrowed coin and flash loan receipt
   */
  borrowFlashLoan(
    amount: number | bigint,
    coinName: string
  ): [TransactionArg, TransactionArg] {
    const { protocolPkg, version, market } = this.coreIds;
    const coinType = this.getCoinType(coinName);

    const result = this.txBlock.moveCall({
      target: `${protocolPkg}::flash_loan::borrow_flash_loan`,
      typeArguments: [coinType],
      arguments: [
        this.txBlock.object(version),
        this.txBlock.object(market),
        this.txBlock.pure.u64(amount),
      ],
    });

    return [result[0] as any, result[1] as any];
  }

  /**
   * Repay a flash loan to Scallop
   *
   * @param coin - The coin to repay (must include fee)
   * @param receipt - The flash loan receipt (Hot Potato)
   * @param coinName - Coin name (e.g., 'sui', 'usdc')
   */
  repayFlashLoan(
    coin: TransactionArg,
    receipt: TransactionArg,
    coinName: string
  ): void {
    const { protocolPkg, version, market } = this.coreIds;
    const coinType = this.getCoinType(coinName);

    this.txBlock.moveCall({
      target: `${protocolPkg}::flash_loan::repay_flash_loan`,
      typeArguments: [coinType],
      arguments: [
        this.txBlock.object(version),
        this.txBlock.object(market),
        coin as any,
        receipt as any,
      ],
    });
  }
}

/**
 * Scallop Builder - similar to SDK's ScallopBuilder
 *
 * Creates ScallopTxBlock instances and handles signing/sending.
 */
export class ScallopBuilder {
  private client: SuiClient;
  private signer?: Ed25519Keypair;
  private coreIds: ScallopCoreIds;
  private coinTypes: ScallopCoinTypes;

  constructor(options: ScallopBuilderOptions) {
    this.client = options.client;
    this.signer = options.signer;
    this.coreIds = { ...DEFAULT_CORE_IDS, ...options.coreIds };
    this.coinTypes = { ...DEFAULT_COIN_TYPES, ...options.coinTypes };
  }

  /**
   * Create a new ScallopTxBlock
   */
  createTxBlock(): ScallopTxBlock {
    return new ScallopTxBlock(undefined, this.coreIds, this.coinTypes);
  }

  /**
   * Sign and send a ScallopTxBlock
   */
  async signAndSendTxBlock(
    scallopTxBlock: ScallopTxBlock,
    signer?: Ed25519Keypair
  ): Promise<{ digest: string; effects: any }> {
    const keypair = signer || this.signer;
    if (!keypair) {
      throw new Error("No signer provided");
    }

    const result = await this.client.signAndExecuteTransaction({
      transaction: scallopTxBlock.txBlock,
      signer: keypair,
      options: { showEffects: true },
    });

    return {
      digest: result.digest,
      effects: result.effects,
    };
  }

  /**
   * Dry run a ScallopTxBlock
   */
  async dryRunTxBlock(scallopTxBlock: ScallopTxBlock): Promise<{
    success: boolean;
    error?: string;
    effects: any;
  }> {
    const dryRunResult = await this.client.dryRunTransactionBlock({
      transactionBlock: await scallopTxBlock.txBlock.build({
        client: this.client,
      }),
    });

    return {
      success: dryRunResult.effects.status.status === "success",
      error: dryRunResult.effects.status.error,
      effects: dryRunResult.effects,
    };
  }
}

/**
 * Calculate flash loan fee (0.05% = 5 basis points)
 */
export function calculateFlashLoanFee(amount: bigint): bigint {
  const FEE_RATE = 5n;
  const FEE_DENOMINATOR = 10000n;
  return (amount * FEE_RATE) / FEE_DENOMINATOR;
}

export default ScallopBuilder;
