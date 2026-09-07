// SPDX-License-Identifier: Apache-2.0

/**
 * The licence line the fixture archives carry.
 *
 * **One home, deliberately — unlike the stacks that use it.** `/lab`'s `TileSource`s and the
 * app's are separate on purpose and are scheduled to diverge (the basemap increment replaces the
 * app's with a self-hosted extract while `/lab`'s stays cut for its pixel differential). This
 * string is the opposite case: it is not a design choice either page gets to make. The archives
 * are derived works of Copernicus DEM GLO-30 Public and the licence requires this text verbatim
 * (ADR-0024), so two copies are two chances for one to be edited into something the licence does
 * not say — and the page that drifted would keep rendering, keep passing, and be in breach.
 *
 * Lives above both routes rather than inside `lab/`: the app must not import from the fixture
 * harness, and a shared obligation is not the harness's to own.
 */
export const FIXTURE_ATTRIBUTION =
  "Contains modified Copernicus DEM GLO-30 Public data © DLR e.V. and Airbus DS GmbH";
