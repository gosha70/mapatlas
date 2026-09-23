// SPDX-License-Identifier: Apache-2.0
import "maplibre-gl/dist/maplibre-gl.css";

import { setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url"; // Vite

setWorkerUrl(workerUrl);
