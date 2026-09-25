// SPDX-License-Identifier: Apache-2.0

/**
 * A MapLibre raster layer that serves tiles from a local reader instead of
 * the network — the render side of an offline map region. It is decoupled
 * from any particular store: pass a `read(z, x, y)` function (e.g. a
 * PMTiles OfflineRegionStore's `readTile` bound to a region). When the
 * reader has no bytes for a tile, the tile is simply blank, so this works
 * with the network disabled.
 *
 * Implemented as a private `mapatlas-offline://` MapLibre protocol (the GL
 * analogue of Leaflet's `GridLayer.createTile`), registered once globally;
 * each layer instance owns one reader keyed by an id embedded in its tile
 * URLs so multiple offline layers can coexist.
 */
import { addProtocol } from "maplibre-gl";
import type { Map as MaplibreMap } from "maplibre-gl";

export type TileReader = (
  z: number,
  x: number,
  y: number,
) => Promise<ArrayBuffer | undefined>;

export interface OfflineTileLayerOptions {
  attribution?: string;
  minZoom?: number;
  maxZoom?: number;
  opacity?: number;
}

const OFFLINE_PROTOCOL = "mapatlas-offline";
const TILE_URL_RE = /^mapatlas-offline:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/;

// A 1x1 transparent PNG, returned when the reader has no bytes for a tile —
// mirrors the old GridLayer behaviour of leaving the tile blank (no error).
const TRANSPARENT_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function transparentPngBytes(): ArrayBuffer {
  const binary = atob(TRANSPARENT_PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

const readers = new Map<string, TileReader>();
let readerSeq = 0;
let offlineProtocolRegistered = false;

/** Register the global `mapatlas-offline://` MapLibre protocol exactly once. */
function ensureOfflineProtocol(): void {
  if (offlineProtocolRegistered) return;
  addProtocol(OFFLINE_PROTOCOL, async (params) => {
    const match = TILE_URL_RE.exec(params.url);
    if (!match) throw new Error(`invalid offline tile url: ${params.url}`);
    const [, readerId, z, x, y] = match;
    const read = readerId ? readers.get(readerId) : undefined;
    if (!read) throw new Error(`unknown offline reader: ${String(readerId)}`);
    const bytes = await read(Number(z), Number(x), Number(y));
    return { data: bytes ?? transparentPngBytes() };
  });
  offlineProtocolRegistered = true;
}

/** A MapLibre source+layer pair, mirroring Leaflet's `L.Layer.addTo`/`remove`. */
export interface OfflineTileLayer {
  addTo(map: MaplibreMap): OfflineTileLayer;
  remove(): OfflineTileLayer;
}

export function createOfflineTileLayer(
  read: TileReader,
  options: OfflineTileLayerOptions = {},
): OfflineTileLayer {
  ensureOfflineProtocol();
  const readerId = `r${(readerSeq++).toString(36)}`;
  readers.set(readerId, read);

  const sourceId = `mapatlas-offline-${readerId}`;
  const layerId = `${sourceId}-layer`;
  let attachedMap: MaplibreMap | undefined;

  const apply = (map: MaplibreMap): void => {
    map.addSource(sourceId, {
      type: "raster",
      tiles: [`${OFFLINE_PROTOCOL}://${readerId}/{z}/{x}/{y}`],
      tileSize: 256,
      ...(options.attribution !== undefined
        ? { attribution: options.attribution }
        : {}),
      ...(options.minZoom !== undefined ? { minzoom: options.minZoom } : {}),
      ...(options.maxZoom !== undefined ? { maxzoom: options.maxZoom } : {}),
    });
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      ...(options.opacity !== undefined
        ? { paint: { "raster-opacity": options.opacity } }
        : {}),
    });
  };

  const layer: OfflineTileLayer = {
    addTo(map: MaplibreMap): OfflineTileLayer {
      attachedMap = map;
      if (map.isStyleLoaded()) apply(map);
      else map.once("load", () => apply(map));
      return layer;
    },
    remove(): OfflineTileLayer {
      readers.delete(readerId);
      const map = attachedMap;
      if (map) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
        attachedMap = undefined;
      }
      return layer;
    },
  };
  return layer;
}
