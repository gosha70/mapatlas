// SPDX-License-Identifier: Apache-2.0

import type { MediaAnalyzer } from "./interfaces.js";

/**
 * No-op analyzer shipped in v1 (api.md §4, tasks T1.6) so the analysis code
 * path is testable end-to-end without bundling a model or making network
 * requests. It runs locally, produces no labels, and interprets nothing.
 */
export const noopAnalyzer: MediaAnalyzer = {
  id: "noop",
  runsRemotely: false,
  analyze: () => Promise.resolve({ labels: [] }),
};
