// SPDX-License-Identifier: Apache-2.0
import type { Track } from "@mapatlas/core";
import { createWebTrackRecorder } from "@mapatlas/recorder-web";

// Geolocation from the browser, in the foreground. Nothing is persisted unless a `store` is
// given; see @mapatlas/storage-idb for the default one.
const recorder = createWebTrackRecorder();

recorder.onPoint((point) => {
  console.log(point.lat, point.lng, point.t);
});

export async function recordForAMinute(): Promise<Track> {
  await recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  return recorder.stop();
}
