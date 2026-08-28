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

/** The registration seam, injectable so a test can observe it without a MapLibre runtime. */
export interface ProtocolRegistrar {
  addProtocol(scheme: string, handler: unknown): void;
  createProtocol(): { tile: unknown };
}

let registered = false;

/** Test-only: forget the registration so a case can observe the first one again. */
export function resetPmtilesProtocolForTests(): void {
  registered = false;
}

export function isPmtilesProtocolRegistered(): boolean {
  return registered;
}

/**
 * Register the handler if it is not already registered. Idempotent by construction: three
 * controllers over one archive produce exactly one registration.
 */
export function ensurePmtilesProtocol(registrar: ProtocolRegistrar): void {
  if (registered) return;
  const protocol = registrar.createProtocol();
  registrar.addProtocol("pmtiles", protocol.tile);
  registered = true;
}
