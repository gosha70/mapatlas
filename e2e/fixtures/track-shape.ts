// SPDX-License-Identifier: Apache-2.0

/**
 * What a recorded trip and an authored one are allowed to differ in, and why.
 *
 * **Declared here, testable here.** These lists are what `app-equivalence.e2e.ts` tells the
 * structural comparison not to look at, and a declaration that is too wide is a comparison that
 * has stopped meaning anything. Keeping them in a module both the scenario and
 * `structure-oracle.e2e.ts` import is what lets the *specific* lists be checked rather than only
 * the mechanism that applies them.
 *
 * Both are **subtree roots read out of the model and the exporter**, never paths appended after a
 * red run. That distinction is `CONTINUE.md`'s mistake 7b: a list grown one entry per failure is a
 * spot-check whatever the intent behind each entry, while a small set of roots derived by reading
 * the code is a statement — and a *new* representation the model grows later turns the comparison
 * red and forces a decision, instead of being exempted because of what it happened to be called.
 */

/**
 * The fields only a GPS fix can supply.
 *
 * `TrackPoint` publishes exactly these five as optional; `useTrackDraft.append` writes a bare
 * `{lat, lng}` and the timing step adds `t`. Enumerable because the type enumerates them, and held
 * in three places because the same points are kept in three: the track, the Douglas–Peucker render
 * cache (ADR-0018), and the exported feature's properties.
 */
const GPS_FIELDS = ["accuracyM", "altitudeM", "altitudeAccuracyM", "speedMps", "headingDeg"];

export const GPS_ONLY = [
  ...GPS_FIELDS.map((field) => `points[].${field}`),
  ...GPS_FIELDS.map((field) => `simplifiedSegments[][].${field}`),
  ...GPS_FIELDS.map((field) => `features[].properties.${field}`),
];

/**
 * Everywhere the model keeps or derives sensor-channel state (ADR-0040).
 *
 * **Roots the model owns, not any property called `channels`.** An earlier version of this
 * declaration matched the *segment name* wherever it occurred, which reads well and is wrong:
 * `Track.meta` is `Record<string, JSONValue>` and belongs to the consumer, so a consumer payload
 * with a `channels` key of its own would have vanished from the comparison. The seven roots below
 * are read from `track.ts` (`Track.channels`, `TrackPoint.channels`, `simplifiedSegments`),
 * `channels.ts` (`TrackStats.channels`, the derived roll-up) and `portability.ts` (the export's
 * parallel arrays, its descriptors and its copy of the stats). Nothing else is exempt, `meta`
 * included.
 */
export const SENSOR_CHANNEL_ONLY = [
  // On the track: the descriptors the source declared.
  "channels",
  // On the points: the samples merged at each one.
  "points[].channels",
  // And on the render cache's copies of those points.
  "simplifiedSegments[][].channels",
  // Derived: the per-channel roll-up `computeStats` produces.
  "stats.channels",
  // In the export: parallel arrays per key, the descriptors beside them, and the stats copy.
  "features[].properties.channels",
  "features[].properties.channelDescriptors",
  "features[].properties.stats.channels",
];
