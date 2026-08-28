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
  // engine overrides the control explicitly, so a consumer's product shows the tile
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

test("wires the real PMTiles protocol into the real MapLibre runtime", async ({ page }) => {
  // `new Protocol()` and `addProtocol(protocol.tile)` are the documented integration between
  // two exactly-pinned packages. This does not wait for tiles — there is no archive to
  // serve — it proves the two libraries still fit together at these versions, which is what
  // a major bump breaks and what a module mock would hide.
  await page.goto("/");

  const failure = await page.evaluate(() => {
    try {
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
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  expect(failure).toBeNull();
  await expect(page.locator("canvas.maplibregl-canvas")).toHaveCount(1);
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
