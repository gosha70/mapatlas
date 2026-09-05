// SPDX-License-Identifier: Apache-2.0

/**
 * The demo's entry point.
 *
 * `/lab` is the only route so far: T4.6's fixture, human-openable. Anything else lands on a
 * pointer to it rather than a blank page.
 */

import "maplibre-gl/dist/maplibre-gl.css";

// MapLibre 6 resolves its worker relative to the *importing* chunk, so under a bundler that
// rewrites imports the request lands beside the rewritten chunk and 404s. Nothing errors: the
// map constructs, the style parses, sources emit `sourcedata`, and no tile is ever built. A
// canvas mounts and stays empty — which is precisely what a smoke test reporting "one canvas,
// no page errors" cannot tell apart from a working map.
//
// `?worker&url` asks the bundler for a URL it will actually serve. This is a **consumer**
// responsibility, documented as one: the engine cannot do it, because the right URL depends on
// the consumer's bundler. `maplibre-gl` is a peer dependency of `@mapatlas/maplibre` for the
// same reason, so the demo declares it directly.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { setWorkerUrl } from "maplibre-gl";

import {
  labTileSources,
  mountLab,
  readLabFocus,
  readLabSegments,
  readLabSources,
} from "./lab/lab.js";
import { readLabOffline, runLabOffline } from "./lab/offline-region.js";
import { mountPersistenceControl } from "./persistence.js";

setWorkerUrl(maplibreWorkerUrl);

const app = document.querySelector<HTMLElement>("#app");
if (app === null) throw new Error("the demo page has no #app element to mount into");

if (window.location.pathname === "/lab") {
  const status = document.createElement("p");
  status.id = "status";
  status.textContent = "Replaying the fixture track…";
  const map = document.createElement("div");
  map.id = "map";
  app.append(status, map);

  const here = new URL(window.location.href);
  const labSources = readLabSources(here);

  // **The offline step runs to completion before the map is mounted**, and that ordering is the
  // contract, not a convenience: `installOfflineArchives` has to reach the protocol before
  // anything adds a `pmtiles` source, or MapLibre resolves the url over the network first and
  // the later registration serves nothing (ADR-0036).
  //
  // `data-offline` is published *before* `data-assembled`, so a scenario can assert what the
  // region step produced without having to infer it from what the map then drew — which is the
  // precondition a render assertion cannot make for itself.
  runLabOffline(readLabOffline(here), labTileSources(labSources))
    .then((report) => {
      // The **step**, not a count: always present, so a scenario can wait on it as "the offline
      // step is finished" without that marker also having to carry a number the step may not
      // know. `data-regions` is published separately, and only when the store was consulted.
      status.dataset["offline"] = report.mode;
      if (report.regions !== undefined) status.dataset["regions"] = String(report.regions);
      if (report.regionId !== undefined) status.dataset["regionId"] = report.regionId;
      if (report.sizeBytes !== undefined) status.dataset["regionBytes"] = String(report.sizeBytes);
      if (report.sourceIds !== undefined)
        status.dataset["regionSources"] = report.sourceIds.join(",");
      status.dataset["served"] = report.served.join(",");
      return mountLab(map, labSources, readLabSegments(here), readLabFocus(here));
    })
    .then((lab) => {
      // **Not "ready".** This resolves when the recording is finished and the controller has
      // been told what to draw; MapLibre installs sources and layers later, when its style
      // loads. Calling it ready would invite a scenario to treat it as proof that something
      // painted, which it cannot be — the differential pixel oracle establishes that.
      status.dataset["assembled"] = "true";
      status.dataset["points"] = String(lab.track.points.length);
      status.dataset["segments"] = String(lab.track.segments.length);
      status.dataset["events"] = String(lab.events.length);
      status.dataset["rendered"] = String(lab.rendered.points.length);
      status.textContent =
        `${String(lab.track.points.length)} points, ` +
        `${String(lab.track.segments.length)} segments, ` +
        `${String(lab.events.length)} marks`;
    })
    .catch((error: unknown) => {
      status.dataset["failed"] = "true";
      status.textContent = `Lab failed: ${error instanceof Error ? error.message : String(error)}`;
    });
} else {
  // The root route: a pointer to `/lab`, and the persistence control (T6.2).
  //
  // **Only this branch changes.** `/lab` is T4.6's fixture and the subject of four merged
  // browser scenarios, and T6.1's offline evidence runs through it; a persistence control has
  // nothing to do with any of them and is not worth putting them at risk for.
  const intro = document.createElement("p");
  intro.style.font = "14px system-ui";
  intro.innerHTML = 'MAP-ATLAS demo. Open <a href="/lab">/lab</a>.';
  app.append(intro);
  mountPersistenceControl(app);
}
