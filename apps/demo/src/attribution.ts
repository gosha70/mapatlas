// SPDX-License-Identifier: Apache-2.0

/**
 * The licence line the fixture archives carry.
 *
 * **One home, deliberately — unlike the stacks that use it.** The app's `TileSource`s and the
 * renderer proofs' (`e2e/fixtures/fixture-stack.ts`) are separate on purpose: the app's carry a
 * self-hosted basemap extract, the proofs' stay cut for a pixel differential. This string is the
 * opposite case: it is not a design choice either consumer gets to make. The archives are derived
 * works of Copernicus DEM GLO-30 Public and the licence requires this text verbatim (ADR-0024),
 * so two copies are two chances for one to be edited into something the licence does not say —
 * and the consumer that drifted would keep rendering, keep passing, and be in breach.
 *
 * Lives in the app rather than beside the proofs: the app must not import from the test
 * fixtures, and a shared obligation is not the fixtures' to own.
 */
export const FIXTURE_ATTRIBUTION =
  "Contains modified Copernicus DEM GLO-30 Public data © DLR e.V. and Airbus DS GmbH";

/**
 * The line the self-hosted basemap extract carries (ADR-0038).
 *
 * **A second line, never a replacement.** The map draws two derived works from two unrelated
 * sources: the Copernicus DEM above and the OpenStreetMap extract here. Each carries its own
 * obligation, and a control showing one of them is in breach for the other — so both are declared
 * and MapLibre renders both.
 *
 * **Verbatim, and the same words the archive carries.** The OSMF attribution guidelines mandate
 * attribution to "OpenStreetMap" and accept `© OpenStreetMap contributors`; ODbL §4.3 requires
 * the notice to say the content is available under this License. Composed here exactly as
 * `runBuild` composes the archive's own `attribution`, from the same checked-in
 * `fixtures/basemap/notice.json` — and `attribution.test.ts` compares this string against that
 * file, so the map and the archive cannot come to say different things.
 */
export const BASEMAP_ATTRIBUTION =
  "© OpenStreetMap contributors — data available under the " +
  "Open Database License (ODbL) 1.0, https://opendatacommons.org/licenses/odbl/1-0/ — " +
  "source https://www.openstreetmap.org/copyright";
