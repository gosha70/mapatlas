// SPDX-License-Identifier: Apache-2.0
import type { LayerSpecification, SourceSpecification } from "maplibre-gl";
import { describe, expect, it } from "vitest";

import type { MapConstructorOptions } from "./environment.js";
import { FakeMapError, createFakeMap } from "./fake-map.js";

/**
 * The fake's own tests.
 *
 * Every controller test is only as good as this: a fake that quietly accepts an illegal
 * call would let a broken install order pass here and fail in a browser. These pin the four
 * rules the real MapLibre enforces, so the verifier is checked independently of the code it
 * verifies.
 */

const OPTIONS: MapConstructorOptions = {
  container: {} as HTMLElement,
  style: "https://styles.invalid/base.json",
  attributionControl: { customAttribution: [] },
};

const RASTER = {
  type: "raster",
  tiles: ["https://tiles.invalid/{z}/{x}/{y}.png"],
} as unknown as SourceSpecification;

function layer(id: string, source: string): LayerSpecification {
  return { id, type: "raster", source } as LayerSpecification;
}

describe("it enforces what MapLibre enforces", () => {
  it("rejects a duplicate source id", () => {
    const map = createFakeMap(OPTIONS);
    map.addSource("osm", RASTER);
    expect(() => {
      map.addSource("osm", RASTER);
    }).toThrow(FakeMapError);
  });

  it("rejects a layer naming a source that is not installed", () => {
    const map = createFakeMap(OPTIONS);
    expect(() => {
      map.addLayer(layer("osm__raster", "osm"));
    }).toThrow(/names no installed source/);
  });

  it("rejects removing a source a layer still references", () => {
    // This is the rule that makes "layers before sources" a testable claim rather than a
    // comment. Without it the controller could tear down in either order and pass.
    const map = createFakeMap(OPTIONS);
    map.addSource("osm", RASTER);
    map.addLayer(layer("osm__raster", "osm"));

    expect(() => {
      map.removeSource("osm");
    }).toThrow(/still used by layer/);

    map.removeLayer("osm__raster");
    expect(() => {
      map.removeSource("osm");
    }).not.toThrow();
  });

  it("rejects terrain naming a source that is not installed", () => {
    const map = createFakeMap(OPTIONS);
    expect(() => {
      map.setTerrain({ source: "dem", exaggeration: 1 });
    }).toThrow(/names no installed source/);
  });

  it("rejects removing a source terrain still references", () => {
    // This is what makes the controller's release-terrain-first ordering a behavioural
    // requirement rather than an assertion about a call log: get it wrong and this throws,
    // exactly as MapLibre's own removeSource does.
    const map = createFakeMap(OPTIONS);
    map.addSource("dem", RASTER);
    map.setTerrain({ source: "dem", exaggeration: 1 });

    expect(() => {
      map.removeSource("dem");
    }).toThrow(/still used by terrain/);

    map.setTerrain(null);
    expect(() => {
      map.removeSource("dem");
    }).not.toThrow();
  });

  it("reports the terrain currently applied, as MapLibre's getTerrain does", () => {
    const map = createFakeMap(OPTIONS);
    expect(map.terrain).toBeNull();

    map.addSource("dem", RASTER);
    map.setTerrain({ source: "dem", exaggeration: 2 });
    expect(map.terrain).toEqual({ source: "dem", exaggeration: 2 });

    map.setTerrain(null);
    expect(map.terrain).toBeNull();
  });

  it("rejects removing what was never added", () => {
    const map = createFakeMap(OPTIONS);
    expect(() => {
      map.removeLayer("nothing");
    }).toThrow(/no layer/);
    expect(() => {
      map.removeSource("nothing");
    }).toThrow(/no source/);
  });

  it("rejects any use after remove()", () => {
    const map = createFakeMap(OPTIONS);
    map.remove();
    expect(() => {
      map.addSource("osm", RASTER);
    }).toThrow(/after remove/);
    expect(() => {
      map.setTerrain(null);
    }).toThrow(/after remove/);
  });
});

describe("it records faithfully", () => {
  it("reports calls in arrival order and holdings in installation order", () => {
    const map = createFakeMap(OPTIONS);
    map.addSource("osm", RASTER);
    map.addLayer(layer("osm__raster", "osm"));
    map.addSource("seamarks", RASTER);

    expect(map.calls.map((call) => call.op)).toEqual(["addSource", "addLayer", "addSource"]);
    expect(map.sourceIds).toEqual(["osm", "seamarks"]);
    expect(map.layerIds).toEqual(["osm__raster"]);
    // The whole definition, not just the id: tests assert on what MapLibre actually received.
    expect(map.layerSpecs).toEqual([layer("osm__raster", "osm")]);
  });

  it("fires load to every listener, and forgets one that was taken off", () => {
    const map = createFakeMap(OPTIONS);
    const seen: string[] = [];
    const first = (): void => void seen.push("first");
    const second = (): void => void seen.push("second");

    map.on("load", first);
    map.on("load", second);
    map.off("load", first);
    map.fireLoad();

    expect(seen).toEqual(["second"]);
    expect(map.loadListenerCount).toBe(1);
  });

  it("keeps the options it was constructed with", () => {
    expect(createFakeMap(OPTIONS).options).toBe(OPTIONS);
  });
});
