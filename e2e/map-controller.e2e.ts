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
