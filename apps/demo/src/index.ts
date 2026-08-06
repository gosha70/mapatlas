// SPDX-License-Identifier: Apache-2.0

/**
 * MAP-ATLAS demo — a generic field logger (no real domain) that wires the whole
 * engine together (recorder + map + events + storage + offline) and doubles as
 * the manual test bed. The full record→pin→photo→review loop, offline behaviour,
 * reload survival, and GeoJSON export are proven headlessly in `loop.test.ts`.
 */
export { App, DEMO_SOURCES } from "./App";
export type { AppProps } from "./App";
export { createIdbTileCache } from "./idb-tile-cache";
