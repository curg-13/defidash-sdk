/**
 * DeFi Dash SDK - Leverage Route Finder
 *
 * Discovers the best protocol for leverage given an asset,
 * comparing maxMultiplier and net APY across all initialized protocols.
 */

import {
  LendingProtocol,
  ILendingProtocol,
  LeveragePreview,
  LeverageRouteResult,
  FindBestRouteParams,
  LEVERAGE_MULTIPLIER_BUFFER,
} from "../types";
import { InvalidParameterError } from "../utils/errors";

/** Safety margin subtracted from maxMultiplier when requesting a near-max preview */
const MAX_MULT_SAFETY_MARGIN = 0.01;

/** Minimum safe multiplier floor (below this leverage has negligible effect) */
const MIN_SAFE_MULTIPLIER = 1.1;

// ── Dependency injection ─────────────────────────────────────────────────────

export interface FindBestRouteDeps {
  /** Map of all initialized protocol adapters */
  protocols: Map<LendingProtocol, ILendingProtocol>;
  /** Function to call previewLeverage for a given protocol + params */
  previewFn: (
    protocol: LendingProtocol,
    params: {
      depositAsset: string;
      depositAmount?: string;
      depositValueUsd?: number;
      multiplier: number;
    },
  ) => Promise<LeveragePreview>;
  /** Resolve asset symbol to coin type */
  resolveCoinType: (asset: string) => string;
}

// ── Main function ────────────────────────────────────────────────────────────

/**
 * Find the best leverage route across all initialized protocols.
 *
 * Returns two recommendations:
 * 1. **bestMaxMultiplier** — the protocol offering the highest possible leverage
 * 2. **bestApy** — the protocol with the highest net APY at a safe multiplier
 */
export async function findBestLeverageRoute(
  params: FindBestRouteParams,
  deps: FindBestRouteDeps,
): Promise<LeverageRouteResult> {
  // ── Input validation ───────────────────────────────────────────────────────
  if (!params.depositAmount && !params.depositValueUsd) {
    throw new InvalidParameterError(
      "Either depositAmount or depositValueUsd must be provided",
    );
  }
  if (params.depositAmount && params.depositValueUsd) {
    throw new InvalidParameterError(
      "Cannot provide both depositAmount and depositValueUsd. Choose one.",
    );
  }

  const coinType = deps.resolveCoinType(params.depositAsset);
  const allProtocols = Array.from(deps.protocols.keys());

  // ── Phase 1: Risk params (lightweight) ─────────────────────────────────────
  const riskResults = await Promise.allSettled(
    allProtocols.map((protocol) =>
      deps.protocols
        .get(protocol)!
        .getAssetRiskParams(coinType)
        .then((riskParams) => ({ protocol, riskParams })),
    ),
  );

  type RiskEntry = {
    protocol: LendingProtocol;
    riskParams: { maxMultiplier: number; ltv: number };
  };
  const successfulRisk: RiskEntry[] = [];
  const failedProtocols: Array<{
    protocol: LendingProtocol;
    error: string;
  }> = [];

  riskResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      successfulRisk.push(result.value);
    } else {
      failedProtocols.push({
        protocol: allProtocols[i],
        error: result.reason?.message || String(result.reason),
      });
    }
  });

  if (successfulRisk.length === 0) {
    throw new InvalidParameterError(
      `No protocol supports asset "${params.depositAsset}" for leverage. ` +
        `Errors: ${failedProtocols.map((f) => `${f.protocol}: ${f.error}`).join("; ")}`,
    );
  }

  // ── Safe multiplier ────────────────────────────────────────────────────────
  const minMaxMultiplier = Math.min(
    ...successfulRisk.map((r) => r.riskParams.maxMultiplier),
  );
  const safeMultiplier = Math.max(
    MIN_SAFE_MULTIPLIER,
    minMaxMultiplier - LEVERAGE_MULTIPLIER_BUFFER,
  );

  // ── Best max-multiplier protocol ───────────────────────────────────────────
  const bestMaxEntry = successfulRisk.reduce((best, curr) =>
    curr.riskParams.maxMultiplier > best.riskParams.maxMultiplier
      ? curr
      : best,
  );

  // ── Phase 2: Previews ─────────────────────────────────────────────────────
  const maxMultPreviewPromise = deps.previewFn(bestMaxEntry.protocol, {
    depositAsset: params.depositAsset,
    depositAmount: params.depositAmount,
    depositValueUsd: params.depositValueUsd,
    multiplier:
      Math.round((bestMaxEntry.riskParams.maxMultiplier - MAX_MULT_SAFETY_MARGIN) * 100) / 100,
  });

  const safePreviewResults = await Promise.allSettled(
    successfulRisk.map(({ protocol }) =>
      deps
        .previewFn(protocol, {
          depositAsset: params.depositAsset,
          depositAmount: params.depositAmount,
          depositValueUsd: params.depositValueUsd,
          multiplier: safeMultiplier,
        })
        .then((preview) => ({ protocol, preview })),
    ),
  );

  type PreviewEntry = {
    protocol: LendingProtocol;
    preview: LeveragePreview;
  };
  const safeSuccessful: PreviewEntry[] = [];

  safePreviewResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      safeSuccessful.push(result.value);
    } else {
      failedProtocols.push({
        protocol: successfulRisk[i].protocol,
        error: `Failed at safe multiplier ${safeMultiplier}x: ${result.reason?.message}`,
      });
    }
  });

  if (safeSuccessful.length === 0) {
    throw new InvalidParameterError(
      `No protocol could preview at safe multiplier ${safeMultiplier}x for "${params.depositAsset}"`,
    );
  }

  // ── Best APY protocol ──────────────────────────────────────────────────────
  const bestApyEntry = safeSuccessful.reduce((best, curr) =>
    curr.preview.netApy > best.preview.netApy ? curr : best,
  );

  const maxMultPreview = await maxMultPreviewPromise;

  return {
    bestMaxMultiplier: {
      protocol: bestMaxEntry.protocol,
      multiplier:
        Math.round((bestMaxEntry.riskParams.maxMultiplier - MAX_MULT_SAFETY_MARGIN) * 100) / 100,
      preview: maxMultPreview,
    },
    bestApy: {
      protocol: bestApyEntry.protocol,
      multiplier: safeMultiplier,
      preview: bestApyEntry.preview,
    },
    safeMultiplier,
    allPreviews: safeSuccessful,
    failedProtocols,
  };
}
