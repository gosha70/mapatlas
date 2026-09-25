// SPDX-License-Identifier: Apache-2.0

/**
 * Translate a domain-neutral {@link TileSource} into a MapLibre GL raster
 * source + layer pair. Three kinds are supported: `xyz` slippy templates,
 * `wms` endpoints (via MapLibre's `{bbox-epsg-3857}` raster tile-URL
 * placeholder), and `pmtiles` single-file archives (registered once as a
 * global `pmtiles://` protocol — the basis for the offline regions in
 * Phase 6). Attribution rides on the source verbatim so the map's
 * attribution control renders exactly what the source declared.
 *
 * MapLibre requires the style to be loaded before `addSource`/`addLayer`
 * (Leaflet's layer model was synchronous). `MapLibreTileLayer.addTo` defers
 * to `map.once("load", ...)` when the style is not ready yet, so a layer
 * created before load still takes effect once it fires.
 */
import { addProtocol } from "maplibre-gl";
import type { Map as MaplibreMap } from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { TileSource } from "@mapatlas/core";

const PMTILES_PROTOCOL = "pmtiles";
let pmtilesProtocolRegistered = false;

/** Register the global `pmtiles://` MapLibre protocol exactly once. */
function ensurePMTilesProtocol(): void {
  if (pmtilesProtocolRegistered) return;
  const protocol = new Protocol();
  addProtocol(PMTILES_PROTOCOL, protocol.tile);
  pmtilesProtocolRegistered = true;
}

/** Build a WMS GetMap tile-URL template using MapLibre's bbox placeholder. */
function wmsTileUrl(source: TileSource): string {
  const sep = source.url.includes("?") ? "&" : "?";
  return (
    `${source.url}${sep}bbox={bbox-epsg-3857}&format=image/png` +
    "&service=WMS&version=1.1.1&request=GetMap&srs=EPSG:3857" +
    "&width=256&height=256"
  );
}

/** A MapLibre source+layer pair, mirroring Leaflet's `L.Layer.addTo`/`remove`. */
export interface MapLibreTileLayer {
  addTo(map: MaplibreMap): MapLibreTileLayer;
  remove(): MapLibreTileLayer;
}

/**
 * Build the MapLibre source+layer pair for `source`. `pmtiles` sources
 * render raster tiles from the archive at `source.url` via the `pmtiles://`
 * protocol; browsers auto-detect the tile image type from its bytes.
 */
export function createTileLayer(source: TileSource): MapLibreTileLayer {
  const sourceId = `mapatlas-src-${source.id}`;
  const layerId = `${sourceId}-layer`;
  let attachedMap: MaplibreMap | undefined;

  const buildSourceSpec = () => {
    const shared = {
      attribution: source.attribution,
      ...(source.minZoom !== undefined ? { minzoom: source.minZoom } : {}),
      ...(source.maxZoom !== undefined ? { maxzoom: source.maxZoom } : {}),
    };
    if (source.kind === "pmtiles") {
      ensurePMTilesProtocol();
      return {
        type: "raster" as const,
        url: `${PMTILES_PROTOCOL}://${source.url}`,
        tileSize: 256,
        ...shared,
      };
    }
    return {
      type: "raster" as const,
      tiles: [source.kind === "wms" ? wmsTileUrl(source) : source.url],
      tileSize: 256,
      ...shared,
    };
  };

  const apply = (map: MaplibreMap): void => {
    map.addSource(sourceId, buildSourceSpec());
    map.addLayer({
      id: layerId,
      type: "raster",
      source: sourceId,
      ...(source.opacity !== undefined
        ? { paint: { "raster-opacity": source.opacity } }
        : {}),
    });
  };

  const handle: MapLibreTileLayer = {
    addTo(map: MaplibreMap): MapLibreTileLayer {
      attachedMap = map;
      if (map.isStyleLoaded()) apply(map);
      else map.once("load", () => apply(map));
      return handle;
    },
    remove(): MapLibreTileLayer {
      const map = attachedMap;
      if (map) {
        if (map.getLayer(layerId)) map.removeLayer(layerId);
        if (map.getSource(sourceId)) map.removeSource(sourceId);
        attachedMap = undefined;
      }
      return handle;
    },
  };
  return handle;
}
