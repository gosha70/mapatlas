// SPDX-License-Identifier: Apache-2.0

import type { MediaAnalysis } from "./event.js";

export interface AnalyzeInput {
  /** The photo bytes... */
  blob?: Blob;
  /** ...or a reference to already-hosted media. */
  url?: string;
  /** Optional consumer context. The engine passes it through without interpreting it. */
  hint?: { tags?: string[]; category?: string };
}

/**
 * Optional photo analysis. **An egress boundary**: an implementation may send a photo to a
 * remote service, so `runsRemotely` must be honest and the React layer discloses it before
 * sending. The engine calls `analyze` only in response to an explicit user action, and
 * never interprets what a label *means* — it stores and displays; the consumer interprets.
 * (ADR-0005)
 */
export interface MediaAnalyzer {
  readonly id: string;
  /** True implies network egress the consumer must disclose and gate. */
  readonly runsRemotely: boolean;
  analyze(input: AnalyzeInput): Promise<MediaAnalysis>;
}

/**
 * The analyzer shipped in v1, so the analysis code path is exercised without bundling a
 * model. Returns no labels rather than throwing: an absent analyzer and a silent one should
 * behave the same to everything downstream.
 */
export const noopAnalyzer: MediaAnalyzer = {
  id: "noop",
  runsRemotely: false,
  analyze: (): Promise<MediaAnalysis> => Promise.resolve({ labels: [], model: "noop" }),
};
