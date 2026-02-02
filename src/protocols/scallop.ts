/**
 * DeFi Dash SDK - Scallop Protocol Adapter
 *
 * Implements ILendingProtocol for Scallop
 *
 * IMPORTANT: This adapter uses direct moveCall on the provided Transaction
 * to ensure PTB compatibility with flash loans and swaps.
 *
 * BORROW INCENTIVE HANDLING:
 * - Scallop obligations can be "staked" for borrow incentive rewards (SCA, etc.)
 * - Staked obligations are "locked" and cannot perform borrow/withdraw operations
 * - This adapter automatically unstakes/restakes obligations when needed
 */

import { Transaction } from '@mysten/sui/transactions';
import { SuiClient } from '@mysten/sui/client';
import { SUI_CLOCK_OBJECT_ID } from '@mysten/sui/utils';
import { Scallop, ScallopQuery } from '@scallop-io/sui-scallop-sdk';
import {
  ILendingProtocol,
  PositionInfo,
  AssetPosition,
  USDC_COIN_TYPE,
  AccountPortfolio,
  LendingProtocol,
  Position,
} from '../types';
import { normalizeCoinType } from '../utils';
import { getReserveByCoinType } from '../lib/suilend/const';
import { getTokenPrice } from '@7kprotocol/sdk-ts';

/**
 * Scallop address types (fetched dynamically from SDK)
 */
interface ScallopCoreAddresses {
  protocolPkg: string;
  version: string;
  market: string;
  coinDecimalsRegistry: string;
  xOracle: string;
  obligationAccessStore: string;
}

interface ScallopBorrowIncentiveAddresses {
  pkg: string;
  config: string;
  incentivePools: string;
  incentiveAccounts: string;
}

interface ScallopVeScaAddresses {
  config: string;
  treasury: string;
  table: string;
  subsTable: string;
  subsWhitelist: string;
}

// Export coin type map for external use
export { COIN_TYPE_MAP as SCALLOP_COIN_TYPE_MAP };

/**
 * Coin type mappings for Scallop
 *
 * Maps full coin types to Scallop's internal coin names.
 * Required for operations like deposit, withdraw, borrow, repay.
 */
const COIN_TYPE_MAP: Record<string, string> = {
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
 * Scallop lending protocol adapter
 *
 * Addresses are fetched dynamically from Scallop SDK at initialization,
 * so they stay up-to-date when Scallop upgrades their contracts.
 */
export class ScallopAdapter implements ILendingProtocol {
  readonly name = 'scallop';

  /**
   * Scallop's repay takes what it needs and leaves remaining balance in the coin.
   * The original coin object remains valid with any unused portion.
   * This is important for deleverage flow where we pass flash loan coin to repay.
   */
  readonly consumesRepaymentCoin = false;

  private scallop!: Scallop;
  private query!: ScallopQuery;
  private suiClient!: SuiClient;
  private initialized = false;

  // Dynamic addresses from Scallop SDK (populated on initialize)
  private coreAddresses!: ScallopCoreAddresses;
  private borrowIncentiveAddresses!: ScallopBorrowIncentiveAddresses;
  private veScaAddresses!: ScallopVeScaAddresses;

  private coinTypeToNameMap: Record<string, string> = {};
  private coinNameToTypeMap: Record<string, string> = {};

  /**
   * Pending obligation state for first-time leverage flow.
   *
   * When a user has no existing obligation, deposit() creates one but can't
   * finalize it (return hot potato) until AFTER borrow() is called. This state
   * tracks the pending obligation between deposit() and borrow() calls within
   * the same PTB.
   *
   * IMPORTANT: This state must be cleared after use to prevent corruption.
   */
  private pendingObligation: any = null;
  private pendingObligationKey: any = null;
  private pendingHotPotato: any = null;
  private pendingUserAddress: string | null = null;

  /**
   * Track obligations that have been unstaked in the current PTB.
   * Prevents duplicate unstake calls within the same transaction.
   */
  private unstakedObligationsInPTB: Set<string> = new Set();

  async initialize(suiClient: SuiClient): Promise<void> {
    this.suiClient = suiClient;

    // Initialize Scallop SDK
    this.scallop = new Scallop({ networkType: 'mainnet' });
    await this.scallop.init();
    this.query = await this.scallop.createScallopQuery();

    // Fetch addresses from SDK (always up-to-date with protocol upgrades)
    const addresses = this.scallop.client.address.getAddresses();
    if (!addresses) {
      throw new Error('Failed to get Scallop addresses from SDK');
    }
    this.populateAddresses(addresses);

    // Build coin mappings
    for (const [coinType, coinName] of Object.entries(COIN_TYPE_MAP)) {
      const normalized = normalizeCoinType(coinType);
      this.coinTypeToNameMap[normalized] = coinName;
      this.coinNameToTypeMap[coinName] = normalized;
    }

    this.initialized = true;
  }

  /**
   * Populate internal address caches from SDK addresses
   */
  private populateAddresses(addresses: any): void {
    // Core protocol addresses
    this.coreAddresses = {
      protocolPkg: addresses.core.packages?.protocol?.id || '',
      version: addresses.core.version,
      market: addresses.core.market,
      coinDecimalsRegistry: addresses.core.coinDecimalsRegistry,
      xOracle: addresses.core.oracles.xOracle,
      obligationAccessStore: addresses.core.obligationAccessStore,
    };

    // Borrow incentive addresses
    this.borrowIncentiveAddresses = {
      pkg: addresses.borrowIncentive.id,
      config: addresses.borrowIncentive.config,
      incentivePools: addresses.borrowIncentive.incentivePools,
      incentiveAccounts: addresses.borrowIncentive.incentiveAccounts,
    };

    // VeSCA addresses
    this.veScaAddresses = {
      config: addresses.vesca.config,
      treasury: addresses.vesca.treasury,
      table: addresses.vesca.table,
      subsTable: addresses.vesca.subsTable,
      subsWhitelist: addresses.vesca.subsWhitelist,
    };

    console.log(
      `[ScallopAdapter] Loaded addresses - Core pkg: ${this.coreAddresses.protocolPkg.slice(0, 10)}..., BorrowIncentive pkg: ${this.borrowIncentiveAddresses.pkg.slice(0, 10)}...`,
    );
  }

  /**
   * Get current addresses (for external use/debugging)
   */
  getAddresses(): {
    core: ScallopCoreAddresses;
    borrowIncentive: ScallopBorrowIncentiveAddresses;
    vesca: ScallopVeScaAddresses;
  } {
    this.ensureInitialized();
    return {
      core: this.coreAddresses,
      borrowIncentive: this.borrowIncentiveAddresses,
      vesca: this.veScaAddresses,
    };
  }

  private ensureInitialized() {
    if (!this.initialized) {
      throw new Error(
        'ScallopAdapter not initialized. Call initialize() first.',
      );
    }
  }

  private getCoinName(coinType: string): string {
    const normalized = normalizeCoinType(coinType);
    const name = this.coinTypeToNameMap[normalized];
    if (!name) {
      throw new Error(`Unknown coin type for Scallop: ${coinType}`);
    }
    return name;
  }

  private getCoinType(coinName: string): string {
    const coinType = this.coinNameToTypeMap[coinName.toLowerCase()];
    if (!coinType) {
      throw new Error(`Unknown coin name for Scallop: ${coinName}`);
    }
    return coinType;
  }

  // ============================================================================
  // Query Methods (unchanged - use Scallop SDK)
  // ============================================================================

  async getPosition(userAddress: string): Promise<PositionInfo | null> {
    this.ensureInitialized();

    const obligations = await this.query.getObligations(userAddress);
    if (obligations.length === 0) return null;

    const obligation = await this.query.queryObligation(obligations[0].id);
    if (!obligation) return null;

    let collateral: AssetPosition | null = null;
    let debt: AssetPosition | null = null;

    const collaterals = (obligation as any).collaterals || [];
    const debts = (obligation as any).debts || [];

    if (collaterals.length > 0) {
      const col = collaterals[0];
      // Scallop SDK returns type as { name: string }
      const rawCoinType = col.coinType || col.type?.name || '';
      const coinType = normalizeCoinType(rawCoinType);
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 9;
      const amount = BigInt(col.amount || col.depositAmount || 0);
      const price = await getTokenPrice(coinType);

      collateral = {
        amount,
        symbol: reserve?.symbol || this.getCoinName(coinType).toUpperCase(),
        coinType,
        decimals,
        valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
      };
    }

    if (debts.length > 0) {
      const d = debts[0];
      // Scallop SDK returns type as { name: string }
      const rawCoinType = d.coinType || d.type?.name || '';
      const coinType = normalizeCoinType(rawCoinType);
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 6;
      const amount = BigInt(d.amount || d.borrowAmount || 0);
      const price = await getTokenPrice(coinType);

      debt = {
        amount,
        symbol: reserve?.symbol || 'USDC',
        coinType,
        decimals,
        valueUsd: (Number(amount) / Math.pow(10, decimals)) * price,
      };
    }

    if (!collateral) return null;

    return {
      collateral,
      debt: debt || {
        amount: 0n,
        symbol: 'USDC',
        coinType: USDC_COIN_TYPE,
        decimals: 6,
        valueUsd: 0,
      },
      netValueUsd: collateral.valueUsd - (debt?.valueUsd || 0),
    };
  }

  // ============================================================================
  // Transaction Methods (DIRECT moveCall - no separate context)
  // ============================================================================

  /**
   * Open a new obligation
   */
  private openObligation(tx: Transaction): [any, any, any] {
    const result = tx.moveCall({
      target: `${this.coreAddresses.protocolPkg}::open_obligation::open_obligation`,
      arguments: [tx.object(this.coreAddresses.version)],
    });
    return [result[0], result[1], result[2]];
  }

  /**
   * Return obligation (consume hot potato)
   */
  private returnObligation(
    tx: Transaction,
    obligation: any,
    hotPotato: any,
  ): void {
    tx.moveCall({
      target: `${this.coreAddresses.protocolPkg}::open_obligation::return_obligation`,
      arguments: [tx.object(this.coreAddresses.version), obligation, hotPotato],
    });
  }

  /**
   * Add collateral to obligation
   */
  private addCollateral(
    tx: Transaction,
    obligation: any,
    coin: any,
    coinType: string,
  ): void {
    tx.moveCall({
      target: `${this.coreAddresses.protocolPkg}::deposit_collateral::deposit_collateral`,
      typeArguments: [coinType],
      arguments: [
        tx.object(this.coreAddresses.version),
        obligation,
        tx.object(this.coreAddresses.market),
        coin,
      ],
    });
  }

  /**
   * Borrow from obligation
   */
  private borrowFromObligation(
    tx: Transaction,
    obligation: any,
    obligationKey: any,
    amount: bigint,
    coinType: string,
  ): any {
    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: '1',
    });

    const result = tx.moveCall({
      target: `${this.coreAddresses.protocolPkg}::borrow::borrow`,
      typeArguments: [coinType],
      arguments: [
        tx.object(this.coreAddresses.version),
        obligation,
        obligationKey,
        tx.object(this.coreAddresses.market),
        tx.object(this.coreAddresses.coinDecimalsRegistry),
        tx.pure.u64(amount),
        tx.object(this.coreAddresses.xOracle),
        clockRef,
      ],
    });

    return result[0];
  }

  /**
   * Repay debt
   */
  private repayDebt(
    tx: Transaction,
    obligation: any,
    coin: any,
    coinType: string,
  ): void {
    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: '1',
    });

    tx.moveCall({
      target: `${this.coreAddresses.protocolPkg}::repay::repay`,
      typeArguments: [coinType],
      arguments: [
        tx.object(this.coreAddresses.version),
        obligation,
        tx.object(this.coreAddresses.market),
        coin,
        clockRef,
      ],
    });
  }

  // ============================================================================
  // Borrow Incentive Methods (for handling locked obligations)
  // ============================================================================

  /**
   * Unstake obligation from borrow incentive (unlocks it for borrow/withdraw)
   *
   * This must be called before borrow or withdraw on a locked obligation.
   * Error 770 (0x302) indicates the obligation is locked.
   *
   * This method tracks unstaked obligations to prevent duplicate unstake calls
   * within the same PTB.
   */
  unstakeObligation(
    tx: Transaction,
    obligationId: string,
    obligationKeyId: string,
  ): void {
    // Skip if already unstaked in this PTB
    if (this.unstakedObligationsInPTB.has(obligationId)) {
      return;
    }

    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: '1',
    });

    tx.moveCall({
      target: `${this.borrowIncentiveAddresses.pkg}::user::unstake_v2`,
      arguments: [
        tx.object(this.borrowIncentiveAddresses.config),
        tx.object(this.borrowIncentiveAddresses.incentivePools),
        tx.object(this.borrowIncentiveAddresses.incentiveAccounts),
        tx.object(obligationKeyId),
        tx.object(obligationId),
        tx.object(this.veScaAddresses.subsTable),
        tx.object(this.veScaAddresses.subsWhitelist),
        clockRef,
      ],
    });

    // Mark as unstaked in this PTB
    this.unstakedObligationsInPTB.add(obligationId);
  }

  /**
   * Stake obligation to borrow incentive (locks it for rewards)
   *
   * This can be called after borrow/withdraw to re-enable rewards.
   */
  stakeObligation(
    tx: Transaction,
    obligationId: string,
    obligationKeyId: string,
  ): void {
    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: '1',
    });

    tx.moveCall({
      target: `${this.borrowIncentiveAddresses.pkg}::user::stake`,
      arguments: [
        tx.object(this.borrowIncentiveAddresses.config),
        tx.object(this.borrowIncentiveAddresses.incentivePools),
        tx.object(this.borrowIncentiveAddresses.incentiveAccounts),
        tx.object(obligationKeyId),
        tx.object(obligationId),
        tx.object(this.coreAddresses.obligationAccessStore),
        clockRef,
      ],
    });
  }

  /**
   * Check if an obligation is locked (staked in borrow incentive)
   */
  async isObligationLocked(obligationId: string): Promise<boolean> {
    this.ensureInitialized();
    const response = await this.suiClient.getObject({
      id: obligationId,
      options: { showContent: true },
    });

    if (response.data?.content?.dataType === 'moveObject') {
      const fields = response.data.content.fields as any;
      return Boolean(fields.lock_key);
    }
    return false;
  }

  /**
   * Clear pending obligation state
   *
   * Call this if a transaction fails after deposit() but before borrow()
   * to reset the adapter state.
   *
   * Also clears the unstaked obligations tracking for the next PTB.
   */
  clearPendingState(): void {
    this.pendingObligation = null;
    this.pendingObligationKey = null;
    this.pendingHotPotato = null;
    this.pendingUserAddress = null;
    this.unstakedObligationsInPTB.clear();
  }

  /**
   * Check if there's a pending obligation (for debugging)
   */
  hasPendingObligation(): boolean {
    return this.pendingObligation !== null;
  }

  // ============================================================================
  // ILendingProtocol Implementation
  // ============================================================================

  async deposit(
    tx: Transaction,
    coin: any,
    coinType: string,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const obligations = await this.query.getObligations(userAddress);

    if (obligations.length > 0) {
      // Use existing obligation
      const obligationId = obligations[0].id;
      this.addCollateral(tx, tx.object(obligationId), coin, normalized);
    } else {
      // Create new obligation - DO NOT return it yet!
      // We need to keep the obligation/key references valid for the borrow call
      // that happens later in the same transaction (leverage flow)
      const [obligation, obligationKey, hotPotato] = this.openObligation(tx);
      this.addCollateral(tx, obligation, coin, normalized);

      // Store references for borrow in same transaction
      // Note: We delay returnObligation until AFTER borrow is called
      this.pendingObligation = obligation;
      this.pendingObligationKey = obligationKey;
      this.pendingHotPotato = hotPotato;
      this.pendingUserAddress = userAddress;
    }
  }

  /**
   * Withdraw collateral from obligation
   *
   * Automatically unstakes locked obligations (staked in borrow incentive).
   * Does NOT restake after - call stakeObligation manually if needed.
   *
   * @param tx - Transaction to add calls to
   * @param coinType - Type of coin to withdraw
   * @param amount - Amount to withdraw (raw units)
   * @param userAddress - User's address
   */
  async withdraw(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
  ): Promise<any> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const obligations = await this.query.getObligations(userAddress);

    if (obligations.length === 0) {
      throw new Error('No obligation found for withdrawal');
    }

    const obligation = obligations[0];
    const obligationId = obligation.id;
    const obligationKeyId = obligation.keyId;
    const isLocked = obligation.locked;

    // Auto-unstake if obligation is locked (staked in borrow incentive)
    if (isLocked) {
      this.unstakeObligation(tx, obligationId, obligationKeyId);
    }

    const clockRef = tx.sharedObjectRef({
      objectId: SUI_CLOCK_OBJECT_ID,
      mutable: false,
      initialSharedVersion: '1',
    });

    const result = tx.moveCall({
      target: `${this.coreAddresses.protocolPkg}::withdraw_collateral::withdraw_collateral`,
      typeArguments: [normalized],
      arguments: [
        tx.object(this.coreAddresses.version),
        tx.object(obligationId),
        tx.object(obligationKeyId),
        tx.object(this.coreAddresses.market),
        tx.object(this.coreAddresses.coinDecimalsRegistry),
        tx.pure.u64(BigInt(amount)),
        tx.object(this.coreAddresses.xOracle),
        clockRef,
      ],
    });

    return result[0];
  }

  /**
   * Borrow from obligation
   *
   * Automatically unstakes locked obligations (staked in borrow incentive).
   * Does NOT restake after - call stakeObligation manually if needed.
   *
   * @param tx - Transaction to add calls to
   * @param coinType - Type of coin to borrow
   * @param amount - Amount to borrow (raw units)
   * @param userAddress - User's address
   * @param _skipOracle - Unused (kept for interface compatibility)
   */
  async borrow(
    tx: Transaction,
    coinType: string,
    amount: string,
    userAddress: string,
    _skipOracle?: boolean,
  ): Promise<any> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const obligations = await this.query.getObligations(userAddress);

    // Check if we have a pending obligation from deposit in same transaction
    if (
      obligations.length === 0 &&
      this.pendingObligation &&
      this.pendingObligationKey &&
      this.pendingHotPotato
    ) {
      // Use pending obligation created earlier in this transaction
      // New obligations are never locked, so no need to unstake
      const result = this.borrowFromObligation(
        tx,
        this.pendingObligation,
        this.pendingObligationKey,
        BigInt(amount),
        normalized,
      );

      // NOW finalize the obligation (after borrow, not after deposit!)
      this.returnObligation(tx, this.pendingObligation, this.pendingHotPotato);
      tx.transferObjects([this.pendingObligationKey], this.pendingUserAddress!);

      // Clear pending state after use
      this.pendingObligation = null;
      this.pendingObligationKey = null;
      this.pendingHotPotato = null;
      this.pendingUserAddress = null;

      return result;
    }

    if (obligations.length === 0) {
      throw new Error('No obligation found for borrowing');
    }

    const obligation = obligations[0];
    const obligationId = obligation.id;
    const obligationKeyId = obligation.keyId;
    const isLocked = obligation.locked;

    // Auto-unstake if obligation is locked (staked in borrow incentive)
    if (isLocked) {
      this.unstakeObligation(tx, obligationId, obligationKeyId);
    }

    return this.borrowFromObligation(
      tx,
      tx.object(obligationId),
      tx.object(obligationKeyId),
      BigInt(amount),
      normalized,
    );
  }

  /**
   * Repay debt to obligation
   *
   * IMPORTANT: Repay operations also require the obligation to be unlocked!
   * This method automatically unstakes locked obligations before repaying.
   *
   * @param tx - Transaction to add calls to
   * @param coinType - Type of coin to repay
   * @param coin - Coin object to repay with
   * @param userAddress - User's address
   */
  async repay(
    tx: Transaction,
    coinType: string,
    coin: any,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const normalized = normalizeCoinType(coinType);
    const obligations = await this.query.getObligations(userAddress);

    if (obligations.length === 0) {
      throw new Error('No obligation found for repayment');
    }

    const obligation = obligations[0];
    const obligationId = obligation.id;
    const obligationKeyId = obligation.keyId;
    const isLocked = obligation.locked;

    // Auto-unstake if obligation is locked (required for repay operations)
    if (isLocked) {
      this.unstakeObligation(tx, obligationId, obligationKeyId);
    }

    this.repayDebt(tx, tx.object(obligationId), coin, normalized);
  }

  async refreshOracles(
    _tx: Transaction,
    _coinTypes: string[],
    _userAddress: string,
  ): Promise<void> {
    // Scallop oracle refresh is embedded in borrow/withdraw calls via xOracle
    // No separate refresh needed for basic operations
  }

  /**
   * Get all obligations for a user with their locked status
   *
   * @param userAddress - User's address
   * @returns Array of obligation info with locked status
   */
  async getObligations(userAddress: string): Promise<
    Array<{
      id: string;
      keyId: string;
      locked: boolean;
    }>
  > {
    this.ensureInitialized();
    const obligations = await this.query.getObligations(userAddress);
    return obligations.map((o) => ({
      id: o.id,
      keyId: o.keyId,
      locked: o.locked ?? false,
    }));
  }

  /**
   * Get detailed obligation data including collaterals and debts
   *
   * @param obligationId - Obligation ID to query
   * @returns Detailed obligation data or null if not found
   */
  async getObligationDetails(obligationId: string): Promise<{
    collaterals: Array<{
      coinType: string;
      amount: string;
    }>;
    debts: Array<{
      coinType: string;
      amount: string;
    }>;
    locked: boolean;
  } | null> {
    this.ensureInitialized();

    const [obligationData, isLocked] = await Promise.all([
      this.query.queryObligation(obligationId),
      this.isObligationLocked(obligationId),
    ]);

    if (!obligationData) return null;

    const oblData = obligationData as any;
    const collaterals = (oblData.collaterals || []).map((col: any) => ({
      coinType: normalizeCoinType(col.coinType || col.type?.name || ''),
      amount: String(col.amount || col.depositAmount || 0),
    }));

    const debts = (oblData.debts || []).map((d: any) => ({
      coinType: normalizeCoinType(d.coinType || d.type?.name || ''),
      amount: String(d.amount || d.borrowAmount || 0),
    }));

    return {
      collaterals,
      debts,
      locked: isLocked,
    };
  }

  async getAccountPortfolio(address: string): Promise<AccountPortfolio> {
    this.ensureInitialized();

    const emptyPortfolio: AccountPortfolio = {
      protocol: LendingProtocol.Scallop,
      address,
      healthFactor: Infinity,
      netValueUsd: 0,
      totalCollateralUsd: 0,
      totalDebtUsd: 0,
      positions: [],
    };

    const obligations = await this.query.getObligations(address);
    if (obligations.length === 0) return emptyPortfolio;

    const obligation = await this.query.queryObligation(obligations[0].id);
    if (!obligation) return emptyPortfolio;

    const positions: Position[] = [];
    let totalCollateralUsd = 0;
    let totalDebtUsd = 0;

    const oblData = obligation as any;
    const collaterals = oblData.collaterals || [];
    const debts = oblData.debts || [];

    for (const col of collaterals) {
      const coinType = normalizeCoinType(col.coinType || col.type?.name || '');
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 9;
      const amount =
        Number(col.amount || col.depositAmount || 0) / Math.pow(10, decimals);
      const price = await getTokenPrice(coinType);
      const valueUsd = amount * price;

      totalCollateralUsd += valueUsd;
      positions.push({
        protocol: LendingProtocol.Scallop,
        coinType,
        symbol: reserve?.symbol || 'UNKNOWN',
        side: 'supply',
        amount,
        valueUsd,
        apy: 0,
      });
    }

    for (const d of debts) {
      const coinType = normalizeCoinType(d.coinType || d.type?.name || '');
      const reserve = getReserveByCoinType(coinType);
      const decimals = reserve?.decimals || 6;
      const amount =
        Number(d.amount || d.borrowAmount || 0) / Math.pow(10, decimals);
      const price = await getTokenPrice(coinType);
      const valueUsd = amount * price;

      totalDebtUsd += valueUsd;
      positions.push({
        protocol: LendingProtocol.Scallop,
        coinType,
        symbol: reserve?.symbol || 'USDC',
        side: 'borrow',
        amount,
        valueUsd,
        apy: 0,
      });
    }

    return {
      protocol: LendingProtocol.Scallop,
      address,
      healthFactor:
        totalDebtUsd > 0 ? totalCollateralUsd / totalDebtUsd : Infinity,
      netValueUsd: totalCollateralUsd - totalDebtUsd,
      totalCollateralUsd,
      totalDebtUsd,
      positions,
    };
  }

  // ============================================================================
  // Helper Methods for External Use
  // ============================================================================

  /**
   * Get Scallop coin name from full coin type
   *
   * @param coinType - Full coin type (e.g., "0x2::sui::SUI")
   * @returns Scallop coin name (e.g., "sui") or undefined if not found
   */
  getCoinNameFromType(coinType: string): string | undefined {
    const normalized = normalizeCoinType(coinType);
    return this.coinTypeToNameMap[normalized];
  }

  /**
   * Get full coin type from Scallop coin name
   *
   * @param coinName - Scallop coin name (e.g., "sui")
   * @returns Full coin type or undefined if not found
   */
  getCoinTypeFromName(coinName: string): string | undefined {
    return this.coinNameToTypeMap[coinName.toLowerCase()];
  }

  /**
   * Get all supported coin types with their Scallop names
   *
   * @returns Map of coin type to Scallop name
   */
  getSupportedCoins(): Record<string, string> {
    return { ...this.coinTypeToNameMap };
  }

  /**
   * Get the underlying Scallop SDK instance
   *
   * Useful for advanced operations not covered by this adapter.
   *
   * @returns Scallop SDK instance
   */
  getScallopSDK(): Scallop {
    this.ensureInitialized();
    return this.scallop;
  }

  /**
   * Get the underlying ScallopQuery instance
   *
   * Useful for querying market data, rates, etc.
   *
   * @returns ScallopQuery instance
   */
  getScallopQuery(): ScallopQuery {
    this.ensureInitialized();
    return this.query;
  }

  /**
   * Find the first obligation with active positions
   *
   * @param userAddress - User's address
   * @returns Obligation with collaterals/debts or null
   */
  async findActiveObligation(userAddress: string): Promise<{
    id: string;
    keyId: string;
    locked: boolean;
    collaterals: Array<{ coinType: string; amount: string }>;
    debts: Array<{ coinType: string; amount: string }>;
  } | null> {
    this.ensureInitialized();

    const obligations = await this.getObligations(userAddress);
    if (obligations.length === 0) return null;

    for (const obl of obligations) {
      const details = await this.getObligationDetails(obl.id);
      if (
        details &&
        (details.collaterals.length > 0 || details.debts.length > 0)
      ) {
        return {
          id: obl.id,
          keyId: obl.keyId,
          locked: obl.locked,
          collaterals: details.collaterals,
          debts: details.debts,
        };
      }
    }

    return null;
  }

  /**
   * Restake obligation after borrow/withdraw operations (optional)
   *
   * Call this at the end of a PTB if you want to continue earning
   * borrow incentive rewards after operations that required unstaking.
   *
   * @param tx - Transaction to add stake call to
   * @param userAddress - User's address
   *
   * @example
   * ```typescript
   * // At the end of a deleverage PTB
   * await scallop.restakeObligationIfNeeded(tx, userAddress);
   * ```
   */
  async restakeObligationIfNeeded(
    tx: Transaction,
    userAddress: string,
  ): Promise<void> {
    this.ensureInitialized();

    const obligations = await this.query.getObligations(userAddress);
    if (obligations.length === 0) return;

    const obligation = obligations[0];

    // Only restake if it was previously locked (and we unstaked it)
    // We can't know for sure if we unstaked it in this PTB, so we
    // check if it has any positions that would benefit from staking
    const details = await this.getObligationDetails(obligation.id);
    if (details && details.debts.length > 0) {
      // Has debts = can earn borrow incentives
      this.stakeObligation(tx, obligation.id, obligation.keyId);
    }
  }

  /**
   * Get the SuiClient instance (for external use)
   */
  getSuiClient(): SuiClient {
    this.ensureInitialized();
    return this.suiClient;
  }
}

// Export address types for external use
export type {
  ScallopCoreAddresses,
  ScallopBorrowIncentiveAddresses,
  ScallopVeScaAddresses,
};
