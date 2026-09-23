// SPDX-License-Identifier: Apache-2.0
import type { TileSource } from "@mapatlas/core";
import { MapCanvas, useTrackRecorder } from "@mapatlas/react";
import type { ReactElement } from "react";

// Your archive, served by your application: the engine bundles no map data.
const basemap: TileSource = {
  id: "basemap",
  kind: "vector",
  transport: "pmtiles",
  url: new URL("/basemap.pmtiles", window.location.href).toString(),
  attribution: "© your basemap provider",
};

export function FieldMap(): ReactElement {
  const recorder = useTrackRecorder();
  return (
    <>
      <button onClick={() => void recorder.start()}>Record</button>
      <MapCanvas sources={[basemap]} initialCamera={{ center: { lat: 45.9, lng: 7 }, zoom: 12 }} />
    </>
  );
}
