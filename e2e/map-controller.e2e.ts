// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "@playwright/test";

import type { Page } from "@playwright/test";
import type { TileSource, Track } from "@mapatlas/core";

import type { ConsoleWatch } from "./fixtures/browser.js";
import { consoleFor, serveMapFixtures, watchConsole } from "./fixtures/browser.js";
import { FIXTURE_TERRAIN_SOURCE, fixtureTileSources } from "./fixtures/fixture-stack.js";
import type { SegmentView } from "./fixtures/fixture-track.js";
import {
  FIXTURE_REGION,
  PAUSE_FOCUS_ZOOM,
  generateFixtureTrack,
  pauseEndpoints,
  selectSegments,
} from "./fixtures/fixture-track.js";
import type { Box, Raster } from "./fixtures/pixels.js";
import {
  boundsOf,
  changedMask,
  countIn,
  countMask,
  decodePng,
  difference,
  intersection,
  trackMask,
  union,
} from "./fixtures/pixels.js";
import { settleRender } from "./fixtures/rendered.js";

/**
 * Every map test fetches tiles now that the worker runs, so the hosts these specs invent are
 * served with real fixtures, and anything unexpected on the console fails the test that
 * produced it. A lane that always prints errors cannot fail on one.
 */
let console_: ConsoleWatch;

test.beforeEach(async ({ page }) => {
  await serveMapFixtures(page);
  console_ = watchConsole(page);
});

test.afterEach(({ page }, testInfo) => {
  // Only when the test itself passed: a test that already failed has its own diagnosis, and
  // console noise from the failure would bury it.
  if (testInfo.status === testInfo.expectedStatus) {
    expect(consoleFor(page).problems()).toEqual([]);
  }
});

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
  // The host answers, but with bytes that are not an archive — deliberately, since this
  // proves the handler is *registered and reached*, not that it can read one. The rejection
  // is therefore **required**, not merely tolerated: without it the test would pass in the
  // case it exists to rule out, where the flag flips true but nothing ever reaches the
  // handler. Matched on the client's own wording so a different failure cannot stand in for
  // it.
  console_.expect(
    /Wrong magic number for PMTiles archive/,
    "the registered handler read the served bytes and rejected them, which is what proves it was reached",
  );

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

  // And wait for the handler to actually be reached. Registration is set during install,
  // synchronously; reading the archive is the end of an asynchronous chain that finishes
  // after it. Ending here would leave the reachability claim unproven — which is precisely
  // what it did until the declaration was made to require its error rather than tolerate it.
  await expect.poll(() => console_.settled()).toBe(true);
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
      const probe = window.mapatlas.mountWithProbe({
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
      window.mapatlas.probe = probe;
    },
    [RASTER_TEMPLATE, DEM_TEMPLATE, OSM_ATTRIBUTION],
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
  expect(await page.evaluate(() => window.mapatlas.probe?.getTerrain() ?? null)).toBeNull();

  await page.evaluate(() => {
    window.mapatlas.probe?.controller.setTerrain({ sourceId: "dem", exaggeration: 1.5 });
  });
  expect(await page.evaluate(() => window.mapatlas.probe?.getTerrain() ?? null)).toMatchObject({
    source: "dem",
    exaggeration: 1.5,
  });

  await page.evaluate(() => {
    window.mapatlas.probe?.controller.setTerrain(null);
  });
  expect(await page.evaluate(() => window.mapatlas.probe?.getTerrain() ?? null)).toBeNull();
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
        const probe = window.mapatlas.mountWithProbe({
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
        window.mapatlas.probe = probe;
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    [RASTER_TEMPLATE, DEM_TEMPLATE, VECTOR_TEMPLATE, OSM_ATTRIBUTION],
  );

  expect(failure).toBeNull();
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Contour data");

  // The assertion that stops this going false-green. Attribution proves the *source* was
  // accepted; it says nothing about the layers. MapLibre can report a layer-validation error
  // and return without adding the layer rather than throwing, so a stack whose hillshade and
  // contour layers were both silently dropped would still reach every check above. Ask the
  // library whether the generated ids are in the style.
  const layers = await page.evaluate(() => ({
    shade: window.mapatlas.probe?.hasLayer("dem__shade") ?? false,
    lines: window.mapatlas.probe?.hasLayer("contours__lines") ?? false,
    absent: window.mapatlas.probe?.hasLayer("contours__never") ?? false,
  }));
  expect(layers).toEqual({ shade: true, lines: true, absent: false });

  // Terrain came from the constructor, so this also proves the load-time ordering: the DEM
  // was installed before terrain named it, or MapLibre would have refused.
  expect(await page.evaluate(() => window.mapatlas.probe?.getTerrain() ?? null)).toMatchObject({
    source: "dem",
  });
});

/** A base style that brings its own terrain, which MapLibre applies as the style loads. */
const STYLE_WITH_TERRAIN = {
  version: 8,
  sources: {
    "style-dem": {
      type: "raster-dem",
      tiles: ["https://tiles.invalid/dem/{z}/{x}/{y}.png"],
      tileSize: 512,
      encoding: "mapbox",
    },
  },
  layers: [],
  terrain: { source: "style-dem", exaggeration: 1 },
};

test("MapLibre does apply a base style's terrain on its own", async ({ page }) => {
  // Establishes the premise the next test depends on. Without it, "terrain is null after
  // load" would pass against a library that never applied the style's terrain at all, and
  // the controller's ownership would be unproven rather than proven.
  await page.goto("/");

  await page.evaluate((style) => {
    window.mapatlas.rawMap = window.mapatlas.mountRawMap(style);
  }, STYLE_WITH_TERRAIN);

  await expect
    .poll(async () => page.evaluate(() => window.mapatlas.rawMap?.getTerrain() ?? null))
    .not.toBeNull();
});

test("takes ownership of terrain a base style declared", async ({ page }) => {
  // The controller never applied this terrain, but it does own it. One that remembered only
  // what *it* set would believe there is none and leave the style's running — so applied
  // state is read from the map, which cannot drift. The test above proves MapLibre really
  // does apply it, so reaching null here is a clearing rather than an absence.
  await page.goto("/");

  await page.evaluate(
    ([style, raster, attribution]) => {
      window.mapatlas.probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        style: style as never,
        // No terrain of its own: desired state is "none", and the style's terrain is what
        // the controller has to clear to make that true.
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
    },
    [STYLE_WITH_TERRAIN, RASTER_TEMPLATE, OSM_ATTRIBUTION] as const,
  );

  // Waiting on the attribution first means the style loaded and the controller installed, so
  // this is "cleared after MapLibre applied it" rather than "read before it did".
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
  await expect
    .poll(async () => page.evaluate(() => window.mapatlas.probe?.getTerrain() ?? null))
    .toBeNull();
});

/** A short track with two points, so it has a line, a start mark and a finish mark. */
const TRACK = {
  id: "trk-1",
  startedAt: 1_700_000_000_000,
  status: "finalized",
  origin: "recorded",
  points: [
    { lat: 59.33, lng: 18.06, t: 1_700_000_000_000 },
    { lat: 59.34, lng: 18.07, t: 1_700_000_060_000 },
  ],
  segments: [{ id: "seg-1", startIndex: 0, endIndex: 1, startedAt: 1_700_000_000_000 }],
};

test("renders a track through layers MapLibre actually accepts", async ({ page }) => {
  // The engine's own layers carry filter expressions — `["==", ["geometry-type"], "Point"]` —
  // and MapLibre validates those. It can report a validation error and return *without*
  // adding the layer rather than throwing, so their presence has to be asked of the library.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution, track]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.renderTrack(track as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, TRACK] as const,
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
  const layers = await page.evaluate(() => ({
    track: window.mapatlas.probe?.hasLayer("mapatlas:track-line") ?? false,
    draftLine: window.mapatlas.probe?.hasLayer("mapatlas:draft-line") ?? false,
    draftVertex: window.mapatlas.probe?.hasLayer("mapatlas:draft-vertex") ?? false,
  }));
  expect(layers).toEqual({ track: true, draftLine: true, draftVertex: true });
  expect(errors).toEqual([]);
});

test("places real, accessible marks in the page", async ({ page }) => {
  // The accessibility contract asserted against a real browser's DOM rather than an
  // implementation of one: a name, a role, and a tab stop on an element the engine owns,
  // with the consumer's markup hidden inside it.
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution, track]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.renderTrack(track as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, TRACK] as const,
  );

  const marks = page.locator(".mapatlas-marker");
  await expect(marks).toHaveCount(2);
  await expect(marks.first()).toHaveAttribute("role", "img");
  await expect(marks.first()).toHaveAttribute("aria-label", /Track (start|finish)/);
  // The consumer's markup is inside the wrapper and hidden, so a mark is announced once by
  // its name rather than twice by its name and its contents.
  await expect(marks.first().locator("[aria-hidden='true']")).toHaveCount(1);

  // Laid out with real dimensions, *and inside the map*. Size alone is not enough: a mark
  // that lost its absolute positioning has perfectly good dimensions and sits hundreds of
  // pixels down the document, outside the container it belongs to. Only a real layout engine
  // with the renderer's stylesheet loaded can settle either question.
  const layout = await page.evaluate(() => {
    const container = document.querySelector(".maplibregl-map")?.getBoundingClientRect();
    return {
      container: container === undefined ? null : { ...container.toJSON() },
      marks: [...document.querySelectorAll(".mapatlas-marker")].map((node) => ({
        ...node.getBoundingClientRect().toJSON(),
        // The wrapper *is* the marker element — MapLibre takes it via the `element` option
        // and puts its own class and positioning on it directly.
        position: getComputedStyle(node).position,
      })),
    };
  });

  expect(layout.container).not.toBeNull();
  expect(layout.marks).toHaveLength(2);
  for (const mark of layout.marks) {
    expect(mark.width).toBeGreaterThan(0);
    expect(mark.height).toBeGreaterThan(0);
    // MapLibre positions its markers absolutely; normal flow means the stylesheet is absent
    // or its class was clobbered.
    expect(mark.position).toBe("absolute");
    expect(mark.top).toBeGreaterThanOrEqual(layout.container!.top);
    expect(mark.bottom).toBeLessThanOrEqual(layout.container!.bottom);
    expect(mark.left).toBeGreaterThanOrEqual(layout.container!.left);
    expect(mark.right).toBeLessThanOrEqual(layout.container!.right);
  }

  // And anchored at the tip, not the middle: the anchor has to reach MapLibre's constructor,
  // or a pin sits half above the place it points at. MapLibre stamps its own class for this.
  await expect(page.locator(".maplibregl-marker-anchor-bottom")).toHaveCount(2);
  await expect(page.locator(".maplibregl-marker-anchor-center")).toHaveCount(0);
});

test("anchors the live position at its centre, not its base", async ({ page }) => {
  // The other half of the anchor claim: a dot marks a position rather than a place, so it is
  // centred on the coordinate. Two marks with the same anchor would prove nothing about
  // whether the value is forwarded at all.
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.showLivePosition({ lat: 59.33, lng: 18.06, t: 1_700_000_000_000 });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION] as const,
  );

  await expect(page.locator(".mapatlas-marker")).toHaveCount(1);
  await expect(page.locator(".maplibregl-marker-anchor-center")).toHaveCount(1);
  await expect(page.locator(".maplibregl-marker-anchor-bottom")).toHaveCount(0);
});

test("keeps its own layers when the consumer stack is replaced", async ({ page }) => {
  // MapLibre throws on an unknown `beforeId`, so a broken anchor surfaces here as a page
  // error rather than as a track quietly drawn beneath a fresh basemap.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution, track]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.renderTrack(track as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, TRACK] as const,
  );
  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);

  await page.evaluate(
    ([raster]) => {
      window.mapatlas.probe?.controller.setSources([
        {
          id: "replacement",
          kind: "raster",
          transport: "template",
          url: raster as string,
          attribution: "Replacement basemap",
        },
      ]);
    },
    [RASTER_TEMPLATE] as const,
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText("Replacement basemap");
  expect(await page.evaluate(() => window.mapatlas.probe?.hasLayer("mapatlas:track-line"))).toBe(
    true,
  );
  // The marks survive too: they are DOM, not layers, and nothing about the basemap changing
  // should disturb where the user's track began and ended.
  await expect(page.locator(".mapatlas-marker")).toHaveCount(2);
  expect(errors).toEqual([]);
});

test("a mark keeps the renderer's own classes across a re-render", async ({ page }) => {
  // Refreshing a mark's style must not assign `className`: MapLibre adds its own classes
  // after construction — `maplibregl-marker`, the anchor class, terrain visibility state —
  // and assigning wipes them. Losing `maplibregl-marker` costs the mark its absolute
  // positioning, so it drops into normal flow and lands outside the map. A live position
  // re-renders on every fix, which makes it the fastest way to reach the bug.
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.showLivePosition({ lat: 59.33, lng: 18.06, t: 1 });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION] as const,
  );
  await expect(page.locator(".mapatlas-marker")).toHaveCount(1);

  // Three more fixes, each one a refresh of the same element.
  await page.evaluate(() => {
    for (const lat of [59.34, 59.35, 59.36]) {
      window.mapatlas.probe?.controller.showLivePosition({ lat, lng: 18.06, t: 2 });
    }
  });

  const mark = page.locator(".mapatlas-marker");
  await expect(mark).toHaveCount(1);
  await expect(mark).toHaveClass(/maplibregl-marker/);
  await expect(mark).toHaveClass(/maplibregl-marker-anchor-center/);
  await expect(mark).toHaveClass(/mapatlas-mark--live/);

  const stillPlaced = await page.evaluate(() => {
    const node = document.querySelector(".mapatlas-marker");
    const container = document.querySelector(".maplibregl-map");
    if (node === null || container === null) return null;
    const mark = node.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    return {
      position: getComputedStyle(node).position,
      inside: mark.top >= box.top && mark.bottom <= box.bottom,
    };
  });
  expect(stillPlaced).toEqual({ position: "absolute", inside: true });
});

test("draws consumer marks and per-segment line styling on the real map", async ({ page }) => {
  // MapLibre validates the data-driven paint expressions the presentation feeds — a `coalesce`
  // over a missing feature property, a filter separating dashed from solid — and can report a
  // layer error and return without adding the layer rather than throwing. So both line layers
  // are asked for by id, and the consumer's marks are read out of the real DOM.
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution, track]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.setPresentation({
        marker: () => ({ ariaLabel: "A consumer mark" }),
        startMarker: () => ({ ariaLabel: "Where I set off", anchor: "bottom" }),
        finishMarker: () => null,
        trackLine: (_t: unknown, index: number) =>
          index === 0 ? { color: "#aa00aa", widthPx: 6 } : { dashed: true },
      } as never);
      probe.controller.renderTrack(track as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, TRACK] as const,
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);

  // The finish mark was suppressed by the consumer, so exactly one remains.
  const marks = page.locator(".mapatlas-marker");
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveAttribute("aria-label", "Where I set off");

  const layers = await page.evaluate(() => ({
    solid: window.mapatlas.probe?.hasLayer("mapatlas:track-line") ?? false,
    dashed: window.mapatlas.probe?.hasLayer("mapatlas:track-line-dashed") ?? false,
  }));
  expect(layers).toEqual({ solid: true, dashed: true });
  expect(errors).toEqual([]);
});

test("a rejected presentation leaves the real map exactly as it was", async ({ page }) => {
  // Against the real DOM: the mark that was there is the same element afterwards, so a
  // keyboard user holding focus on it keeps it.
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution, track]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.setPresentation({
        marker: () => ({ ariaLabel: "A consumer mark" }),
        startMarker: () => ({ ariaLabel: "Original start" }),
        finishMarker: () => null,
      } as never);
      probe.controller.renderTrack(track as never);
      // An event as well, so the callback that throws below is one that actually runs.
      probe.controller.renderEvents([
        { id: "e1", position: { lat: 59.33, lng: 18.06 }, occurredAt: 1, media: [], tags: [] },
      ] as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, TRACK] as const,
  );
  await expect(page.locator(".mapatlas-marker")).toHaveCount(2);

  // Mark the surviving element, so a rebuild is detectable rather than merely a re-render.
  await page.evaluate(() => {
    document
      .querySelector('.mapatlas-marker[aria-label="Original start"]')
      ?.setAttribute("data-original", "yes");
  });

  const rejected = await page.evaluate(() => {
    try {
      window.mapatlas.probe?.controller.setPresentation({
        // A different anchor, which would force a rebuild, then a failure.
        startMarker: () => ({ ariaLabel: "Rebuilt", anchor: "center" }),
        marker: () => {
          throw new Error("consumer blew up");
        },
        lapMarker: () => {
          throw new Error("consumer blew up");
        },
      } as never);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  expect(rejected).toBe("consumer blew up");
  await expect(page.locator(".mapatlas-marker")).toHaveCount(2);

  // The same element, not a replacement: had reconciliation begun before the later callback
  // threw, the anchor change would already have rebuilt this one and taken its focus with it.
  const start = page.locator('.mapatlas-marker[aria-label="Original start"]');
  await expect(start).toHaveCount(1);
  await expect(start).toHaveAttribute("data-original", "yes");
  await expect(start).toHaveClass(/maplibregl-marker-anchor-bottom/);
});

/**
 * An asset with declared intrinsic dimensions, larger than any mark that holds it.
 *
 * Inline as a data URI so the cases need no network and cannot flake on one, and so
 * `naturalWidth` is deterministic enough to assert before the containment claim.
 */
const OVERSIZED_ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">' +
      '<rect width="200" height="100" fill="#0969da"/></svg>',
  );

/** Runs in the page: the mark's box, its image's box, and the asset's real size. */
function measureMark(): {
  wrapper: { width: number; height: number };
  image: { width: number; height: number };
  naturalWidth: number;
} | null {
  const wrapper = document.querySelector(".mapatlas-marker");
  const image = wrapper?.querySelector("img");
  if (wrapper == null || image == null) return null;
  const w = wrapper.getBoundingClientRect();
  const i = image.getBoundingClientRect();
  return {
    wrapper: { width: w.width, height: w.height },
    image: { width: i.width, height: i.height },
    naturalWidth: image.naturalWidth,
  };
}

test("keeps a consumer icon inside the mark it was sized for", async ({ page }) => {
  // A 200x100 asset in a 24x24 mark. Only a real layout engine settles this: whether the
  // constraint is *applied* is a unit concern, whether it *holds* is a cascade one, and an
  // unconstrained image overflows a wrapper that measures correctly and reports no error.
  //
  // The asset is an inline SVG data URI with declared intrinsic dimensions, so the case needs
  // no network and cannot flake on one.
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution, icon]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.setPresentation({
        marker: () => ({ ariaLabel: "A marked spot", iconUrl: icon as string, sizePx: [24, 24] }),
      } as never);
      probe.controller.renderEvents([
        { id: "e1", position: { lat: 59.33, lng: 18.06 }, occurredAt: 1, media: [], tags: [] },
      ] as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, OVERSIZED_ICON] as const,
  );

  await expect(page.locator(".mapatlas-marker")).toHaveCount(1);
  await expect(page.locator(".mapatlas-marker img")).toHaveCount(1);

  const boxes = await page.evaluate(measureMark);

  // The asset really is larger than the mark, or the assertion below proves nothing.
  expect(boxes?.naturalWidth).toBe(200);
  expect(boxes?.wrapper).toEqual({ width: 24, height: 24 });
  expect(boxes?.image).toEqual({ width: 24, height: 24 });
});

test("constrains an icon in a mark sized by a class, not only by sizePx", async ({ page }) => {
  // `className` is a documented styling path, so a consumer may size the mark entirely
  // through CSS and supply no `sizePx` at all. The constraint has to follow that too — which
  // is the reason percentages were chosen over repeating the pixel values.
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution, icon]) => {
      const style = document.createElement("style");
      style.textContent = ".class-sized-mark { width: 24px; height: 24px; }";
      document.head.append(style);

      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.setPresentation({
        // Sized by the class alone: no sizePx.
        marker: () => ({
          ariaLabel: "A marked spot",
          iconUrl: icon as string,
          className: "class-sized-mark",
        }),
      } as never);
      probe.controller.renderEvents([
        { id: "e1", position: { lat: 59.33, lng: 18.06 }, occurredAt: 1, media: [], tags: [] },
      ] as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, OVERSIZED_ICON] as const,
  );

  await expect(page.locator(".mapatlas-marker img")).toHaveCount(1);
  const boxes = await page.evaluate(measureMark);

  expect(boxes?.naturalWidth).toBe(200);
  expect(boxes?.wrapper).toEqual({ width: 24, height: 24 });
  expect(boxes?.image).toEqual({ width: 24, height: 24 });
});

test("leaves an icon at its intrinsic size when nothing sized the mark", async ({ page }) => {
  // The other half of applying the rule unconditionally. `100%` of a wrapper that shrink-wraps
  // its content resolves against the image's own size and changes nothing — a consumer who
  // said nothing about size gets the size the asset came with. Only a layout engine settles
  // that, and asserting it from reasoning is how the previous version of this rule went wrong.
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution, icon]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.probe = probe;
      probe.controller.setPresentation({
        marker: () => ({ ariaLabel: "A marked spot", iconUrl: icon as string }),
      } as never);
      probe.controller.renderEvents([
        { id: "e1", position: { lat: 59.33, lng: 18.06 }, occurredAt: 1, media: [], tags: [] },
      ] as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, OVERSIZED_ICON] as const,
  );

  await expect(page.locator(".mapatlas-marker img")).toHaveCount(1);
  const boxes = await page.evaluate(measureMark);

  expect(boxes?.image).toEqual({ width: 200, height: 100 });
});

test("drags a real vertex without panning the map, then gives panning back", async ({ page }) => {
  // Three separable claims that only a real gesture settles: the vertex moved, the camera did
  // *not* — which is what `preventDefault` plus borrowing `dragPan` exists to guarantee — and
  // panning works again afterwards. A drag that also panned would still report a moved vertex,
  // so the camera claim is the one that matters.
  //
  // The camera is observed through a mark anchored to a coordinate rather than by reading it.
  // Reading it would mean widening the controller's seam for a test, and a mark that stays put
  // while a vertex moves is what a user would actually see.
  await page.goto("/");

  const CENTRE = { lat: 59.33, lng: 18.06 };

  await page.evaluate(
    ([raster, attribution, centre]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        center: centre,
        zoom: 14,
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      } as never);
      window.mapatlas.probe = probe;

      // Vertex 0 sits at the map's centre, so it is at the container's centre on screen and
      // needs no projection to find.
      probe.controller.renderDraft([
        centre as { lat: number; lng: number },
        { lat: 59.332, lng: 18.064 },
      ]);
      // A reference mark well away from the drag path: if the map pans, this moves with it.
      probe.controller.renderEvents([
        {
          id: "reference",
          position: { lat: 59.328, lng: 18.055 },
          occurredAt: 1,
          media: [],
          tags: [],
        },
      ] as never);

      window.mapatlas.drawLog = { moved: [], added: [], clicked: [] };
      window.mapatlas.exitDraw = probe.controller.enterDrawMode({
        onVertexAdd: (at) => window.mapatlas.drawLog?.added.push(at),
        onVertexMove: (index, to) => window.mapatlas.drawLog?.moved.push([index, to]),
        onVertexClick: (index) => window.mapatlas.drawLog?.clicked.push(index),
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, CENTRE] as const,
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
  await expect(page.locator(".mapatlas-mark--event")).toHaveCount(1);
  await expect(page.locator(".mapatlas-draft-vertex")).toHaveCount(2);
  // The draft has to be *painted* before a vertex can be hit-tested, which is what the
  // harness's `setWorkerUrl` call makes possible at all.
  await expect
    .poll(async () => page.evaluate(() => window.mapatlas.probe?.vertexIsRendered() ?? false))
    .toBe(true);

  const start = await page.evaluate(() => {
    const container = document.querySelector(".maplibregl-map")?.getBoundingClientRect();
    const reference = document.querySelector(".mapatlas-mark--event")?.getBoundingClientRect();
    if (container === undefined || reference === undefined) return null;
    return {
      vertex: { x: container.left + container.width / 2, y: container.top + container.height / 2 },
      reference: { x: Math.round(reference.left), y: Math.round(reference.top) },
      dragPan: window.mapatlas.probe?.dragPanEnabled() ?? false,
    };
  });
  expect(start).not.toBeNull();
  expect(start?.dragPan).toBe(true);

  // A real gesture: press on the vertex, move, release.
  await page.mouse.move(start!.vertex.x, start!.vertex.y);
  await page.mouse.down();
  await page.mouse.move(start!.vertex.x + 60, start!.vertex.y + 40, { steps: 8 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const reference = document.querySelector(".mapatlas-mark--event")?.getBoundingClientRect();
    return {
      reference:
        reference === undefined
          ? null
          : { x: Math.round(reference.left), y: Math.round(reference.top) },
      dragPan: window.mapatlas.probe?.dragPanEnabled() ?? false,
      log: window.mapatlas.drawLog,
    };
  });

  // The vertex moved...
  expect(after.log?.moved.length ?? 0).toBeGreaterThan(0);
  expect(after.log?.moved.at(-1)?.[0]).toBe(0);
  // ...the map did not, or the reference mark would have moved with it. Polled, not read
  // once: a marker's transform updates on the renderer's next frame, so reading the rect
  // immediately after the release can find it unmoved because nothing has repainted yet —
  // the assertion carrying this test's whole value passing for the wrong reason.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const r = document.querySelector(".mapatlas-mark--event")?.getBoundingClientRect();
        return r === undefined ? null : { x: Math.round(r.left), y: Math.round(r.top) };
      }),
    )
    .toEqual(start?.reference);
  // ...a drag was not also a click or an add...
  expect(after.log?.clicked).toEqual([]);
  expect(after.log?.added).toEqual([]);
  // ...and panning is back.
  expect(after.dragPan).toBe(true);

  // And the map really does pan once draw mode has released it — so "panning is back" is a
  // statement about the map, not just about a flag.
  await page.evaluate(() => {
    window.mapatlas.exitDraw?.();
  });
  await page.mouse.move(start!.vertex.x, start!.vertex.y + 150);
  await page.mouse.down();
  await page.mouse.move(start!.vertex.x - 90, start!.vertex.y + 150, { steps: 8 });
  await page.mouse.up();

  // Polled for the same reason, in reverse: reading before the pan paints would report the
  // old position and fail intermittently.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const r = document.querySelector(".mapatlas-mark--event")?.getBoundingClientRect();
        return r === undefined ? null : Math.round(r.left);
      }),
    )
    .not.toBe(start?.reference.x);
});

test("a drag survives the pointer crossing a mark inside the map", async ({ page }) => {
  // `mouseout` bubbles, so it fires when the pointer passes over a marker *inside* the map.
  // Treating that as a cancellation re-enables panning while the button is still down, and
  // the rest of the gesture pans the map under the vertex being dragged. Only a real gesture
  // over a real marker settles whether that happens.
  await page.goto("/");

  const CENTRE = { lat: 59.33, lng: 18.06 };

  await page.evaluate(
    ([raster, attribution, centre]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        center: centre,
        zoom: 14,
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      } as never);
      window.mapatlas.probe = probe;
      probe.controller.renderDraft([
        centre as { lat: number; lng: number },
        { lat: 59.332, lng: 18.064 },
      ]);
      // Directly in the drag path, about 75px east of the vertex at this zoom.
      probe.controller.renderEvents([
        {
          id: "in-the-way",
          position: { lat: 59.33, lng: 18.0632 },
          occurredAt: 1,
          media: [],
          tags: [],
        },
      ] as never);
      window.mapatlas.drawLog = { moved: [], added: [], clicked: [] };
      window.mapatlas.exitDraw = probe.controller.enterDrawMode({
        onVertexAdd: (at) => window.mapatlas.drawLog?.added.push(at),
        onVertexMove: (index, to) => window.mapatlas.drawLog?.moved.push([index, to]),
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, CENTRE] as const,
  );

  await expect(page.locator(".mapatlas-mark--event")).toHaveCount(1);
  await expect(page.locator(".mapatlas-draft-vertex")).toHaveCount(2);
  await expect
    .poll(async () => page.evaluate(() => window.mapatlas.probe?.vertexIsRendered() ?? false))
    .toBe(true);

  const from = await page.evaluate(() => {
    const c = document.querySelector(".maplibregl-map")?.getBoundingClientRect();
    return c === undefined ? null : { x: c.left + c.width / 2, y: c.top + c.height / 2 };
  });
  expect(from).not.toBeNull();

  await page.mouse.move(from!.x, from!.y);
  await page.mouse.down();
  const panDuring: boolean[] = [];
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(from!.x + step * 12, from!.y);
    panDuring.push(await page.evaluate(() => window.mapatlas.probe?.dragPanEnabled() ?? true));
  }
  await page.mouse.up();

  // Panning stayed borrowed for the whole gesture, including the frames over the mark...
  expect(panDuring).toEqual(Array.from({ length: 10 }, () => false));
  // ...and every move was reported, rather than half of them being lost to a cancellation.
  expect(await page.evaluate(() => window.mapatlas.drawLog?.moved.length ?? 0)).toBe(10);
  expect(await page.evaluate(() => window.mapatlas.probe?.dragPanEnabled() ?? false)).toBe(true);
});

test("a release still ends the drag when something swallows mouseup on the way up", async ({
  page,
}) => {
  // The seam listens for the release in the *capture* phase. A bubble-phase listener sits at
  // the end of the chain, so a `stopPropagation` anywhere in front of it — the renderer's own
  // handlers, or consumer code on the container, as here — means the release never arrives,
  // the drag never ends and panning never comes back. That is the failure `mouseout` used to
  // mask, reachable again by a different route, so it is guarded by a gesture rather than by
  // reading the listener registration.
  await page.goto("/");

  const CENTRE = { lat: 59.33, lng: 18.06 };

  await page.evaluate(
    ([raster, attribution, centre]) => {
      const probe = window.mapatlas.mountWithProbe({
        container: window.mapatlas.mapContainer(),
        center: centre,
        zoom: 14,
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      } as never);
      window.mapatlas.probe = probe;
      probe.controller.renderDraft([centre as { lat: number; lng: number }]);
      window.mapatlas.drawLog = { moved: [], added: [], clicked: [] };
      probe.controller.enterDrawMode({
        onVertexAdd: (at) => window.mapatlas.drawLog?.added.push(at),
        onVertexMove: (index, to) => window.mapatlas.drawLog?.moved.push([index, to]),
      });

      // A consumer listener that stops the release on its way up. Nothing exotic: any widget
      // that treats a mouseup on the map as its own does this.
      document.querySelector(".maplibregl-map")?.addEventListener("mouseup", (event) => {
        event.stopPropagation();
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION, CENTRE] as const,
  );

  await expect(page.locator(".mapatlas-draft-vertex")).toHaveCount(1);
  await expect
    .poll(async () => page.evaluate(() => window.mapatlas.probe?.vertexIsRendered() ?? false))
    .toBe(true);

  const centre = await page.evaluate(() => {
    const rect = document.querySelector(".maplibregl-map")?.getBoundingClientRect();
    return rect === undefined
      ? null
      : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  expect(centre).not.toBeNull();

  await page.mouse.move(centre!.x, centre!.y);
  await page.mouse.down();
  await page.mouse.move(centre!.x + 40, centre!.y + 30, { steps: 6 });
  await page.mouse.up();

  expect(await page.evaluate(() => (window.mapatlas.drawLog?.moved.length ?? 0) > 0)).toBe(true);
  // The release arrived despite the suppression, so panning came back.
  expect(await page.evaluate(() => window.mapatlas.probe?.dragPanEnabled() ?? false)).toBe(true);
});

test("routes an event mark alone, while an empty-map tap stays a map tap", async ({ page }) => {
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution]) => {
      const controller = window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        center: { lat: 59.33, lng: 18.06 },
        zoom: 14,
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.controller = controller;
      window.mapatlas.interactionLog = { maps: [], events: [] };
      controller.onMapTap((at) => window.mapatlas.interactionLog?.maps.push(at));
      controller.onEventClick((id) => window.mapatlas.interactionLog?.events.push(id));
      controller.renderEvents([
        {
          id: "event-1",
          position: { lat: 59.33, lng: 18.06 },
          occurredAt: 1,
          media: [],
          tags: [],
        },
      ] as never);
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION] as const,
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
  const event = page.getByRole("button", { name: "Event" });
  await expect(event).toHaveCount(1);

  await event.click();
  expect(await page.evaluate(() => window.mapatlas.interactionLog)).toEqual({
    maps: [],
    events: ["event-1"],
  });

  // A genuine canvas tap, far from the centred event mark.
  await page.locator("canvas.maplibregl-canvas").click({ position: { x: 40, y: 40 } });
  expect(await page.evaluate(() => window.mapatlas.interactionLog?.maps.length)).toBe(1);

  // Reach the mark from the map by Tab rather than focusing it directly.
  await page.locator("canvas.maplibregl-canvas").focus();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await page.keyboard.press("Tab");
    if (await event.evaluate((element) => element === document.activeElement)) break;
  }
  expect(await event.evaluate((element) => element === document.activeElement)).toBe(true);
  await page.keyboard.press("Enter");

  expect(await page.evaluate(() => window.mapatlas.interactionLog)).toMatchObject({
    events: ["event-1", "event-1"],
  });
});

test("makes draft vertices one keyboard stop with visible, focus-scoped interaction", async ({
  page,
}) => {
  await page.goto("/");

  await page.evaluate(
    ([raster, attribution]) => {
      const controller = window.mapatlas.createMapController({
        container: window.mapatlas.mapContainer(),
        center: { lat: 59.33, lng: 18.06 },
        zoom: 14,
        sources: [
          {
            id: "osm",
            kind: "raster",
            transport: "template",
            url: raster as string,
            attribution: attribution as string,
          },
        ],
      });
      window.mapatlas.controller = controller;
      const draft = [
        { lat: 59.33, lng: 18.06 },
        { lat: 59.331, lng: 18.062 },
        { lat: 59.332, lng: 18.064 },
      ];
      controller.renderDraft(draft);
      window.mapatlas.drawLog = { moved: [], added: [], clicked: [] };
      window.mapatlas.exitDraw = controller.enterDrawMode({
        onVertexAdd: (at) => window.mapatlas.drawLog?.added.push(at),
        onVertexClick: (index) => window.mapatlas.drawLog?.clicked.push(index),
        onVertexMove: (index, to) => {
          window.mapatlas.drawLog?.moved.push([index, to]);
          draft[index] = to;
          controller.renderDraft(draft);
        },
      });
    },
    [RASTER_TEMPLATE, OSM_ATTRIBUTION] as const,
  );

  await expect(page.locator(".maplibregl-ctrl-attrib")).toContainText(OSM_ATTRIBUTION);
  const vertices = page.locator(".mapatlas-draft-vertex");
  await expect(vertices).toHaveCount(3);
  await expect(page.locator('.mapatlas-draft-vertex[tabindex="0"]')).toHaveCount(1);
  await expect(vertices.nth(0)).toHaveAttribute("aria-label", "Draft vertex 1 of 3");
  await expect(vertices.nth(1)).toHaveAttribute("aria-label", "Draft vertex 2 of 3");
  await expect(vertices.nth(2)).toHaveAttribute("aria-label", "Draft vertex 3 of 3");

  // Reach the composite from the canvas through the browser's real tab order.
  await page.locator("canvas.maplibregl-canvas").focus();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.keyboard.press("Tab");
    if (await vertices.nth(0).evaluate((element) => element === document.activeElement)) break;
  }
  expect(await vertices.nth(0).evaluate((element) => element === document.activeElement)).toBe(
    true,
  );
  expect(
    await vertices.nth(0).evaluate((element) => {
      const style = getComputedStyle(element);
      return { outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth };
    }),
  ).toEqual({ outlineStyle: "solid", outlineWidth: "3px" });

  // Ungrabbed arrows move the roving focus. Grabbed arrows move the vertex instead.
  await page.keyboard.press("ArrowRight");
  expect(await vertices.nth(1).evaluate((element) => element === document.activeElement)).toBe(
    true,
  );
  await page.keyboard.press("Enter");
  await expect(vertices.nth(1)).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(vertices.nth(1)).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.mapatlas.drawLog?.moved.map(([index]) => index))).toEqual(
    [1, 1],
  );

  // Blur is the ordinary cleanup entrance, synchronous with focus transfer.
  await page.keyboard.press("Enter");
  await expect(vertices.nth(1)).toHaveAttribute("aria-pressed", "true");
  await page.locator("canvas.maplibregl-canvas").focus();
  await expect(vertices.nth(1)).toHaveAttribute("aria-pressed", "false");

  // DOM removal is not required to emit blur. Reconciliation therefore releases the grab
  // explicitly and moves focus to the vertex that precedes the removed last one. The unit
  // seam exercises the no-blur path; Chromium is free to emit blur during this real-DOM check.
  await vertices.nth(2).focus();
  await page.keyboard.press("Enter");
  const reconciled = await page.evaluate(() => {
    const removed = document.activeElement as HTMLElement | null;
    window.mapatlas.controller?.renderDraft([
      { lat: 59.33, lng: 18.06 },
      { lat: 59.331, lng: 18.062 },
    ]);
    return {
      removedPressed: removed?.getAttribute("aria-pressed"),
      activeLabel: document.activeElement?.getAttribute("aria-label"),
    };
  });
  expect(reconciled).toEqual({
    removedPressed: "false",
    activeLabel: "Draft vertex 2 of 2",
  });
});

/**
 * Two renderer properties that `/lab`'s pixel differential carried (T4.6) and that the root app
 * cannot observe — T8.3's findings F1 and F2. They are about the renderer, not about any page: a
 * segmented track draws no ink across its pause, and the hillshade layer contributes pixels with
 * its DEM source held fixed. So they live here, against a controller built for the test, with the
 * fixture's own recording as data.
 *
 * **Same viewport, same oracle, same thresholds as the originals had.** They were written while
 * the originals still ran and shown red beside them under one mutation each, the only moment the
 * two could be compared; the figures matched to the pixel (legs 2,817 px, corridor 827 px).
 */
test.describe("renderer differentials", () => {
  test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });

  const ARCHIVES = "http://127.0.0.1:5176";
  /** The demo's blank-style background, `#eceff1` (`apps/demo/src/app/sources.ts`). */
  const BLANK_BACKGROUND = "#eceff1";

  /** How far outside the corridor each leg is allowed to be and still count as reaching it. */
  const CORRIDOR_MARGIN_PX = 8;
  /**
   * Slack in the union relation: measured at **zero** on macOS, allowed for coverage that differs
   * by a fraction between platforms, and two orders of magnitude below the ~800-pixel corridor a
   * bridge draws, so it cannot absorb one.
   */
  const TOLERANCE_FRACTION = 0.01;
  const MIN_TOLERANCE_PX = 16;
  /** Measured at 95.9% on the original; asserted well below, since the claim is "it drew". */
  const MIN_HILLSHADE_FRACTION = 0.2;
  /** Of a 120×120 region — measured between 7,036 and 14,400. */
  const MIN_ROI_CHANGED_PX = 720;
  /** Spread across the viewport, and one in the middle. */
  const HILLSHADE_PROBES: readonly (readonly [number, number])[] = [
    [320, 180],
    [960, 180],
    [320, 540],
    [960, 540],
    [640, 360],
  ];

  interface Camera {
    center: { lat: number; lng: number };
    zoom: number;
  }

  /**
   * What crosses into the page: plain data only, so a function stays on the browser side. The
   * blank style is built there too — the same one the demo's `BLANK_STYLE` declares, restated
   * because a recursive `JSONValue` does not survive Playwright's serialisation typing; the
   * sources and the track cross as `unknown` for the same reason (`TileSource.styleLayers` is
   * `JSONValue[]`; `Track` carries `JSONValue` metadata) and are typed again on the far side.
   */
  interface RenderArguments {
    sources: unknown;
    terrain: { sourceId: string; exaggeration: number } | null;
    track: unknown;
    camera: Camera;
    background: string;
  }

  /**
   * Mount a controller over a viewport-sized container, render a track, and capture what settled.
   *
   * No marks: `renderTrack` anchors start and finish pins to the ends of whatever it is given, so
   * rendering one segment would put a finish pin exactly where the pause is — the renderer behaving
   * correctly, and 176 pixels of purple sitting on the subject. The camera is passed in, never
   * fitted to what is drawn: fitting each selection would give each capture its own camera, and
   * every pixel would then differ for a reason that has nothing to do with the geometry.
   */
  async function captureRender(
    page: Page,
    options: {
      sources: TileSource[];
      terrain?: { sourceId: string; exaggeration: number };
      track: Track;
      camera: Camera;
    },
  ): Promise<Raster> {
    await page.goto("/");
    const render: RenderArguments = {
      sources: options.sources,
      terrain: options.terrain ?? null,
      track: options.track,
      camera: options.camera,
      background: BLANK_BACKGROUND,
    };
    await page.evaluate((args: RenderArguments) => {
      const container = window.mapatlas.mapContainer();
      container.id = "map";
      container.style.position = "fixed";
      container.style.top = "0";
      container.style.left = "0";
      container.style.width = "1280px";
      container.style.height = "720px";
      const probe = window.mapatlas.mountWithProbe({
        container,
        sources: args.sources as TileSource[],
        // A style with no sources of its own, so an empty map needs no network.
        style: {
          version: 8,
          sources: {},
          layers: [
            {
              id: "background",
              type: "background",
              paint: { "background-color": args.background },
            },
          ],
        },
        presentation: {
          // Never reached: no events are rendered. Throwing rather than returning a placeholder,
          // so "no marks" cannot quietly become "marks nobody chose".
          marker: () => {
            throw new Error("no events are rendered here, so no event marker is ever asked for");
          },
          startMarker: () => null,
          finishMarker: () => null,
        },
        ...(args.terrain === null ? {} : { terrain: args.terrain }),
        center: args.camera.center,
        zoom: args.camera.zoom,
      });
      window.mapatlas.probe = probe;
      probe.controller.renderTrack(args.track as Track);
    }, render);
    await page.waitForFunction(() => document.querySelectorAll("#map canvas").length > 0, null, {
      timeout: 30_000,
    });
    return decodePng((await settleRender(page.locator("#map"))).image);
  }

  test("the two-segment render is the union of its segments, and the pause holds no line", async ({
    page,
  }) => {
    // The recording the fixture generates: two segments with a declared pause between them
    // (`fixture-track.test.ts` holds that shape). Rendered over the blank style, with no
    // archives: the pause claim is about the track line, and the stack that makes the gap
    // unreachable at z17 — terrain putting the camera inside the mountain — is left out.
    const track = generateFixtureTrack();
    const { from, to } = pauseEndpoints(track);
    const camera: Camera = {
      center: { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 },
      zoom: PAUSE_FOCUS_ZOOM,
    };
    const render = (view: SegmentView): Promise<Raster> =>
      captureRender(page, { sources: [], track: selectSegments(track, view), camera });

    const both = trackMask(await render("both"));
    const one = trackMask(await render("one"));
    const two = trackMask(await render("two"));
    // A track the renderer **must** draw across: the two points either side of the pause as one
    // two-point segment. Its strictly-new ink is the corridor, measured rather than computed from
    // a projection no consumer can reach — and a corridor in the wrong place would make every
    // negative assertion below a statement about empty space.
    const bridged = trackMask(await render("bridge"));

    const width = 1280;
    const legs = union(one, two);
    const corridor = difference(bridged, legs);
    const box = boundsOf(corridor, width);

    // Positive signal first. Each leg must have drawn something, or every set relation below
    // holds trivially over empty sets.
    expect(countMask(one), "segment one drew nothing").toBeGreaterThan(100);
    expect(countMask(two), "segment two drew nothing").toBeGreaterThan(100);
    expect(countMask(corridor), "the bridged control drew no ink of its own").toBeGreaterThan(100);
    expect(box, "the corridor has no extent").not.toBeNull();

    // **The control region that must change, and the two legs that must reach it.** Without
    // these, "no bridge" is satisfied by a corridor sitting somewhere nothing is drawn.
    const near: Box = {
      x: box!.x - CORRIDOR_MARGIN_PX,
      y: box!.y - CORRIDOR_MARGIN_PX,
      width: box!.width + 2 * CORRIDOR_MARGIN_PX,
      height: box!.height + 2 * CORRIDOR_MARGIN_PX,
    };
    expect(countIn(one, width, near), "segment one does not reach the pause").toBeGreaterThan(0);
    expect(countIn(two, width, near), "segment two does not reach the pause").toBeGreaterThan(0);

    // The set relation. `both` adds nothing the legs do not draw — which is what "no connecting
    // line" means without naming a region — and drops nothing they do, so it cannot pass by
    // rendering less.
    const added = countMask(difference(both, legs));
    const lost = countMask(difference(legs, both));
    const tolerance = Math.max(MIN_TOLERANCE_PX, Math.round(countMask(legs) * TOLERANCE_FRACTION));
    expect(added, `${String(added)} pixels drawn that neither segment draws`).toBeLessThanOrEqual(
      tolerance,
    );
    expect(lost, `${String(lost)} pixels of the segments are missing`).toBeLessThanOrEqual(
      tolerance,
    );

    // The same claim, localised: nothing of the bridge's own ink appears in the real render.
    expect(
      countMask(intersection(both, corridor)),
      "the real render put a line through the pause corridor",
    ).toBe(0);

    console.log(
      `pause: legs ${String(countMask(legs))} px (one ${String(countMask(one))}, two ` +
        `${String(countMask(two))}), both ${String(countMask(both))}, corridor ` +
        `${String(countMask(corridor))} px in ${String(box?.width)}×${String(box?.height)}, ` +
        `added ${String(added)}, lost ${String(lost)}, tolerance ${String(tolerance)}`,
    );
  });

  test("the hillshade layer puts pixels on the map, with its DEM source held fixed", async ({
    page,
  }) => {
    // **The obligation a source-level differential cannot discharge.** Comparing a stack against
    // one with no DEM proves nothing about hillshade: the same archive drives terrain, and terrain
    // alone changes the scene. Here the source, the terrain, the contours, the track and the
    // camera are identical, and the hillshade **layer** is the only difference between the two.
    const track = generateFixtureTrack();
    const camera: Camera = {
      center: {
        lat: (FIXTURE_REGION.south + FIXTURE_REGION.north) / 2,
        lng: (FIXTURE_REGION.west + FIXTURE_REGION.east) / 2,
      },
      zoom: 12,
    };
    const terrainUrl = `${ARCHIVES}/terrain.pmtiles`;
    const contourUrl = `${ARCHIVES}/contours.pmtiles`;
    const terrain = { sourceId: FIXTURE_TERRAIN_SOURCE, exaggeration: 1 };
    const stack = (hillshade: boolean): Promise<Raster> =>
      captureRender(page, {
        sources: fixtureTileSources({ terrainUrl, contourUrl, hillshade }),
        terrain,
        track,
        camera,
      });

    const withLayer = await stack(true);
    const withoutLayer = await stack(false);

    const changed = changedMask(withLayer, withoutLayer);
    const total = withLayer.width * withLayer.height;
    const fraction = countMask(changed) / total;

    expect(fraction, "the hillshade layer changed nothing").toBeGreaterThan(MIN_HILLSHADE_FRACTION);

    // Spread, not just a total: a difference confined to one corner would be some other artefact.
    // Hillshade covers the viewport, so every one of these must move.
    for (const [cx, cy] of HILLSHADE_PROBES) {
      const roi: Box = { x: cx - 60, y: cy - 60, width: 120, height: 120 };
      expect(
        countIn(changed, withLayer.width, roi),
        `nothing changed around ${String(cx)},${String(cy)}`,
      ).toBeGreaterThan(MIN_ROI_CHANGED_PX);
    }

    console.log(
      `hillshade: ${String(countMask(changed))} of ${String(total)} px changed ` +
        `(${(fraction * 100).toFixed(1)}%)`,
    );
  });
});
