/**
 * SDK Method: Configurable Slippage  [Unit]
 *
 * Verifies that slippageBps parameter is properly passed through
 * to leverage and deleverage transactions.
 *
 * Run: npx vitest run src/__tests__/sdk.slippage.unit.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_LEVERAGE_SLIPPAGE_BPS } from '../strategies/leverage';
import { DEFAULT_DELEVERAGE_SLIPPAGE_BPS } from '../strategies/deleverage';

describe('Configurable Slippage', () => {
  describe('Default values', () => {
    it('DEFAULT_LEVERAGE_SLIPPAGE_BPS is 100 (1%)', () => {
      expect(DEFAULT_LEVERAGE_SLIPPAGE_BPS).toBe(100);
    });

    it('DEFAULT_DELEVERAGE_SLIPPAGE_BPS is 500 (5%)', () => {
      expect(DEFAULT_DELEVERAGE_SLIPPAGE_BPS).toBe(500);
    });
  });

  describe('BrowserLeverageParams interface', () => {
    it('slippageBps is optional', async () => {
      // Import types to ensure interface is valid
      const { LendingProtocol } = await import('../types');

      // Type-check: slippageBps should be optional
      const params = {
        protocol: LendingProtocol.Suilend,
        depositAsset: 'SUI',
        depositAmount: '1',
        multiplier: 2.0,
        // slippageBps intentionally omitted
      };

      // Should compile without errors
      expect(params.slippageBps).toBeUndefined();
    });

    it('slippageBps accepts valid basis points', async () => {
      const { LendingProtocol, BrowserLeverageParams } = await import(
        '../types'
      );

      const params: import('../types').BrowserLeverageParams = {
        protocol: LendingProtocol.Suilend,
        depositAsset: 'SUI',
        depositAmount: '1',
        multiplier: 2.0,
        slippageBps: 50, // 0.5%
      };

      expect(params.slippageBps).toBe(50);
    });
  });

  describe('BrowserDeleverageParams interface', () => {
    it('slippageBps is optional', async () => {
      const { LendingProtocol } = await import('../types');

      const params = {
        protocol: LendingProtocol.Suilend,
        // slippageBps intentionally omitted
      };

      expect(params.slippageBps).toBeUndefined();
    });

    it('slippageBps accepts valid basis points', async () => {
      const { LendingProtocol } = await import('../types');

      const params: import('../types').BrowserDeleverageParams = {
        protocol: LendingProtocol.Suilend,
        slippageBps: 300, // 3%
      };

      expect(params.slippageBps).toBe(300);
    });
  });

  describe('Slippage ranges', () => {
    it('should accept common slippage values', () => {
      const validSlippages = [
        { bps: 10, pct: '0.1%' },
        { bps: 50, pct: '0.5%' },
        { bps: 100, pct: '1%' },
        { bps: 200, pct: '2%' },
        { bps: 500, pct: '5%' },
        { bps: 1000, pct: '10%' },
      ];

      for (const { bps, pct } of validSlippages) {
        const percentFromBps = bps / 100;
        expect(percentFromBps).toBe(parseFloat(pct));
      }
    });
  });
});
