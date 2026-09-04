// SPDX-License-Identifier: Apache-2.0

/**
 * The PMTiles protocol handler, registered once per JavaScript realm.
 *
 * `addProtocol` installs a handler on the MapLibre **runtime**, not on a map, and the
 * PMTiles documentation is explicit that it belongs at application lifecycle scope. Making
 * it controller-owned would produce this:
 *
 *     controller A registers pmtiles
 *     controller B is created, sees it registered
 *     controller A.destroy() removes the protocol
 *     controller B breaks, having done nothing wrong
 *
 * So `destroy()` tears down its map, its listeners and its marks, and deliberately leaves
 * this alone. It is infrastructure shared by every map in the realm, not a property of any
 * one of them.
 *
 * Registration is **lazy**: a consumer with no PMTiles sources never constructs a Protocol
 * and never touches the MapLibre global. That keeps the cost off the common path and keeps
 * a side effect out of anything that merely describes a source.
 */

import type { PMTiles } from "pmtiles";

/**
 * The `pmtiles` `Protocol`, in the two respects anything here uses it.
 *
 * `tile` is the handler MapLibre resolves `pmtiles://` urls through. `add` takes a `PMTiles`
 * instance and makes the protocol resolve that archive's url from it instead of the network —
 * which is how a downloaded region is read back (ADR-0035). Named structurally rather than
 * imported as `Protocol` so the seam stays fakeable; `new Protocol()` satisfies it.
 */
export interface PmtilesProtocol {
  tile: unknown;
  add(archive: PMTiles): void;
}

/** The registration seam, injectable so a test can observe it without a MapLibre runtime. */
export interface ProtocolRegistrar {
  addProtocol(scheme: string, handler: unknown): void;
  createProtocol(): PmtilesProtocol;
}

/**
 * Realm-scoped, and deliberately with no way back. A reset would be a production export
 * that exists only for tests, and a consumer could use it to make a second registration
 * possible — the exact state this module exists to prevent. A test that needs a fresh
 * realm re-imports the module (`vi.resetModules()`).
 *
 * The instance itself is the state, not a boolean beside it. It has to be retained anyway —
 * an archive added to a `Protocol` MapLibre never received resolves nothing (ADR-0036) — and
 * "registered" and "the registered protocol" answered by two variables is one fact with two
 * homes, free to disagree the first time either is written without the other.
 */
let protocol: PmtilesProtocol | undefined;

export function isPmtilesProtocolRegistered(): boolean {
  return protocol !== undefined;
}

/**
 * Register the handler if it is not already registered, and return the registered protocol.
 *
 * Idempotent by construction: three controllers over one archive produce exactly one
 * registration, and every caller receives the same instance. Returning it is what lets an
 * offline archive store reach the object MapLibre is actually resolving through — a second
 * `Protocol` would accept archives and be consulted by nothing.
 */
export function ensurePmtilesProtocol(registrar: ProtocolRegistrar): PmtilesProtocol {
  if (protocol === undefined) {
    const created = registrar.createProtocol();
    registrar.addProtocol("pmtiles", created.tile);
    protocol = created;
  }
  return protocol;
}
