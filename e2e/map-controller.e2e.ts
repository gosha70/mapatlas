// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

/**
 * The map controller against a real MapLibre runtime.
 *
 * The source-stack lifecycle is already covered deterministically through the injected
 * environment and a fake that enforces MapLibre's own rules. What only a browser can show
 * is that the default wiring reaches the actual library: MapLibre's ESM worker loading, a
 * real WebGL context, a `load` event that genuinely fires, and the attribution control
 * MapLibre builds — including the default attribution the engine must not ship.
 *
 * The PMTiles case is here for the same reason: `new Protocol()` from `pmtiles` and
 * `addProtocol` on `maplibre-gl` are a two-package integration pinned to exact versions,
 * and a module mock would hide a break in exactly the place a major bump causes one.
 */

const OSM_ATTRIBUTION = "© OpenStreetMap contributors";
const CHART_ATTRIBUTION = "NOAA charts, public domain";

/** No network needed: a `tiles` array resolves without fetching source metadata. */
const RASTER_TEMPLATE = "https://tiles.invalid/{z}/{x}/{y}.png";

/** Elevation and vector templates; like the raster one, they resolve without a network. */
const DEM_TEMPLATE = "https://tiles.invalid/dem/{z}/{x}/{y}.png";
const VECTOR_TEMPLATE = "https://tiles.invalid/vector/{z}/{x}/{y}.pbf";

/** MapLibre's own attribution, which its default control ships and ADR-0008 forbids. */
const LIBRARY_ATTRIBUTION = "MapLibre";

test("mounts a real map and installs the stack when the style loads", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(
    ([url, attribution]) => {
      window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: url!,
            attribution: attribution!,
          },
        ],
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION],
  );

  // Waiting on the attribution proves the whole chain rather than any one link: the style
  // loaded, `load` fired, the controller called `addSource`, and MapLibre accepted it.
  // A canvas alone would appear even if no source was ever installed.
  const attribution = page.locator(".maplibregl-ctrl-attrib");
  await expect(attribution).toContainText(OSM_ATTRIBUTION);
  await expect(page.locator("canvas.maplibregl-canvas")).toHaveCount(1);
});

test("renders with no consumer style, rather than needing setStyle first", async ({ page }) => {
  // MapLibre documents that a map built without `style` needs `setStyle()` before it
  // renders anything. The controller supplies an explicit empty v8 document instead, and
  // this is the only place that claim can actually be checked.
  await page.goto("/");

  await page.evaluate(
    ([url, attribution]) => {
      window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: url!,
            attribution: attribution!,
          },
        ],
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION],
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
});

test("does not ship MapLibre's default attribution", async ({ page }) => {
  // The library's current default attribution control carries its own attribution. The
  // engine overrides the control explicitly, so a consumer's app shows the tile
  // sources' licences and nothing the engine chose on their behalf. (ADR-0008)
  await page.goto("/");

  await page.evaluate(
    ([url, attribution]) => {
      window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: url!,
            attribution: attribution!,
          },
        ],
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION],
  );

  const attribution = page.locator(".maplibregl-ctrl-attrib");
  await expect(attribution).toContainText(OSM_ATTRIBUTION);
  await expect(attribution).not.toContainText(LIBRARY_ATTRIBUTION);
});

test("renders an engine-owned attribution prefix alongside the sources' own", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(
    ([url, attribution]) => {
      window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        attributionPrefix: "Field log",
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: url!,
            attribution: attribution!,
          },
        ],
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION],
  );

  const attribution = page.locator(".maplibregl-ctrl-attrib");
  await expect(attribution).toContainText("Field log");
  await expect(attribution).toContainText(OSM_ATTRIBUTION);
  await expect(attribution).not.toContainText(LIBRARY_ATTRIBUTION);
});

test("replaces a live stack against the real map", async ({ page }) => {
  // The teardown order the fake enforces, run against the library that enforces it for
  // real: MapLibre throws if a source is removed while a layer still references it.
  await page.goto("/");

  const controllerErrors: string[] = [];
  page.on("pageerror", (error) => controllerErrors.push(error.message));

  await page.evaluate(
    ([url, first]) => {
      window.mapatlas.controller = window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        sources: [
          { id: "osm", kind: "raster", transport: "template", url: url!, attribution: first! },
        ],
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION],
  );
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);

  await page.evaluate(
    ([url, second]) => {
      window.mapatlas.controller?.setSources([
        { id: "charts", kind: "raster", transport: "template", url: url!, attribution: second! },
      ]);
    },
    [RASTER_TEMPLATE, CHART_ATTRIBUTION],
  );

  const attribution = page.locator(".maplibregl-ctrl-attrib");
  await expect(attribution).toContainText(CHART_ATTRIBUTION);
  await expect(attribution).not.toContainText(OSM_ATTRIBUTION);
  expect(controllerErrors).toEqual([]);
});

test("registers the real PMTiles protocol on the real MapLibre runtime", async ({ page }) => {
  // `new Protocol()` and `addProtocol(protocol.tile)` are the documented integration between
  // two exactly-pinned packages, and registration is load-gated — so a canvas proves
  // nothing here, since one appears whether or not a source was ever installed. This waits
  // on the registration itself: false before, true only once the style loaded, `install()`
  // ran, a real `Protocol` was constructed and `maplibregl.addProtocol` accepted its tile
  // handler. A break at either version fails here rather than at a consumer's first archive.
  await page.goto("/");

  expect(await page.evaluate(() => window.mapatlas.isPmtilesProtocolRegistered())).toBe(false);

  await page.evaluate(() => {
    window.mapatlas.createMapController({
      container: window.mapatlas.mapContainer(),
      sources: [
        {
          id: "offline",
          kind: "raster",
          transport: "pmtiles",
          url: "https://cdn.invalid/region.pmtiles",
          attribution: "© OpenStreetMap contributors",
        },
      ],
    });
  });

  await expect
    .poll(async () => page.evaluate(() => window.mapatlas.isPmtilesProtocolRegistered()))
    .toBe(true);
});

test("registers nothing for a stack with no PMTiles source", async ({ page }) => {
  // The other half of the same claim, against the real runtime: a consumer who never asks
  // for PMTiles never constructs a Protocol and never touches the MapLibre global. Without
  // this, the test above would still pass if the controller registered unconditionally.
  await page.goto("/");

  await page.evaluate(
    ([url, attribution]) => {
      window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: url!,
            attribution: attribution!,
          },
        ],
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION],
  );

  // Waiting for the attribution first means the map really did finish loading and install,
  // so this is "registered nothing" rather than "was asked too early".
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
  expect(await page.evaluate(() => window.mapatlas.isPmtilesProtocolRegistered())).toBe(false);
});

test("destroy tears the real map down", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(
    ([url, attribution]) => {
      window.mapatlas.controller = window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: url!,
            attribution: attribution!,
          },
        ],
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION],
  );
  await expect(page.locator("canvas.maplibregl-canvas")).toHaveCount(1);

  await page.evaluate(() => {
    window.mapatlas.controller?.destroy();
  });

  // MapLibre's `remove()` empties the container, so the WebGL context is genuinely released
  // rather than left attached to a controller nobody holds.
  await expect(page.locator("canvas.maplibregl-canvas")).toHaveCount(0);
});

test("applies real terrain and removes it, as MapLibre itself reports", async ({ page }) => {
  // `getTerrain()` is MapLibre's own answer to "is terrain on?", so this checks the library's
  // state rather than the controller's belief about it. A DEM whose tiles 404 is enough:
  // `setTerrain` requires the source to exist in the style, not for its tiles to have loaded.
  await page.goto("/");

  await page.evaluate(
    ([raster, dem, attribution]) => {
      const probe = window.mapatlas.mountWithTerrainProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster!,
            attribution: attribution!,
          },
          {
            id: "dem",
            kind: "raster-dem",
            transport: "template",
            url: dem!,
            attribution: "Elevation data",
            role: "terrain",
          },
        ],
      });
      window.mapatlas.terrainProbe = probe;
    },
    [RASTER_TEMPLATE, DEM_TEMPLATE, OSM_ATTRIBUTION],
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
  expect(await page.evaluate(() => window.mapatlas.terrainProbe?.getTerrain() ?? null)).toBeNull();

  await page.evaluate(() => {
    window.mapatlas.terrainProbe?.controller.setTerrain({ sourceId: "dem", exaggeration: 1.5 });
  });
  expect(
    await page.evaluate(() => window.mapatlas.terrainProbe?.getTerrain() ?? null),
  ).toMatchObject({ source: "dem", exaggeration: 1.5 });

  await page.evaluate(() => {
    window.mapatlas.terrainProbe?.controller.setTerrain(null);
  });
  expect(await page.evaluate(() => window.mapatlas.terrainProbe?.getTerrain() ?? null)).toBeNull();
});

test("accepts a DEM + hillshade + contours stack", async ({ page }) => {
  // The fixture from T4.2's acceptance criteria, against the real style validator: MapLibre
  // rejects a hillshade layer over a non-DEM source and a vector layer with no source-layer,
  // so this proves the translation produces a style the library actually accepts — not just
  // one shaped the way the builders think it should be.
  await page.goto("/");

  const failure = await page.evaluate(
    ([raster, dem, vector, attribution]) => {
      const errors: string[] = [];
      window.addEventListener("error", (event) => errors.push(event.message));
      try {
        const probe = window.mapatlas.mountWithTerrainProbe({
          container: window.mapatlas.mapContainer(),
          sources: [
            {
              id: "osm",
              kind: "raster",
              transport: "template",
              url: raster!,
              attribution: attribution!,
            },
            {
              id: "dem",
              kind: "raster-dem",
              transport: "template",
              url: dem!,
              attribution: "Elevation data",
              role: "hillshade",
              styleLayers: [
                { id: "shade", type: "hillshade", paint: { "hillshade-exaggeration": 0.4 } },
              ],
            },
            {
              id: "contours",
              kind: "vector",
              transport: "template",
              url: vector!,
              attribution: "Contour data",
              styleLayers: [
                {
                  id: "lines",
                  type: "line",
                  "source-layer": "contour",
                  paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 15, 1.5] },
                },
              ],
            },
          ],
          terrain: { sourceId: "dem", exaggeration: 1 },
        });
        window.mapatlas.terrainProbe = probe;
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [RASTER_TEMPLATE, DEM_TEMPLATE, VECTOR_TEMPLATE, OSM_ATTRIBUTION],
  );

  expect(failure).toBeNull();
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Contour data");
  // Terrain came from the constructor, so this also proves the load-time ordering: the DEM
  // was installed before terrain named it, or MapLibre would have refused.
  expect(
    await page.evaluate(() => window.mapatlas.terrainProbe?.getTerrain() ?? null),
  ).toMatchObject({ source: "dem" });
});
