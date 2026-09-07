# T7.1 — the demo app

> Bars set 2026-09-06, **before any candidate implementation**, against `main` at `93e9cbe`.
> Four questions were ruled before this plan was written; they are cited below rather than
> re-decided. One of them widens T7.1 beyond its own text and says so where a reader will meet it.

## What is settled — cite, do not re-open

1. **T7.1 discharges its own AC, not Phase 7's exit.** The roadmap's exit is *"`PRD.md` §6 met
   end-to-end, offline"*, and `tasks.md` splits Phase 7 into T7.1, T7.1b, T7.1c and T7.2, which
   discharge it together. Three of §6's seven criteria are T7.1's: the demo records and reviews
   **fully offline**, surviving reload and exporting valid GeoJSON; a `MediaAnalyzer` swaps in
   with zero core changes; a consumer `EventPresentation` renders its own marks with zero
   renderer changes. The hand-drawn-trip criterion is **T7.1b**'s, the sensor channel **T7.1c**'s,
   the afternoon-embed **T7.2**'s, and core's isolation is already enforced by `scan:isolation`.
2. **App-shell offline is T7.1's.** Recorded twice already — T6.1's Done record says *"Serving the
   app shell itself offline is T7.1's"*, and T6.2's fences manifest and service worker to T7.1 by
   name. `PRD.md` §6 requires "fully offline, persists across reload", and **the v1 non-goals list
   does not exclude it** — eleven items, none touching PWA, installation or offline shells
   (checked, because this ruling turns on it). An HTTP cache cannot satisfy "survives reload with
   the network cut", so a service worker is the mechanism.
3. **`/lab` coexists, untouched.** It is T4.6's fixture and carries T6.1's merged evidence through
   five browser scenarios. The app takes `/` and absorbs T6.2's persistence control and
   installation guidance, which are the app's own settings. Rewriting `/lab` into a route of the
   React app would risk merged evidence for no acceptance-criterion gain; retiring it is a later
   task's call, once the app proves the same things.
4. **The source stack is the fixture terrain and contours plus a self-hosted basemap extract for
   the same region.** *Added by ruling on 2026-09-06.* `tasks.md` says "a topographic source
   stack", which covers a basemap in spirit; the **extract pipeline is new work with a new
   licence**, and it is here because it was decided, not because T7.1's text implies it. A later
   reader must not take it for inherited scope.

## Survey — what the repo already has

Findings, before any of them are planned around:

- **The React toolchain is not new work.** `react` and `react-dom` are already pinned at
  `19.2.8` in the root `devDependencies`, with `@types/react` and `@types/react-dom` beside
  them; `@mapatlas/react` declares `react >=18` as a **peer**. What is missing is only the demo's
  own declaration — `apps/demo/package.json` pins `maplibre-gl` and the workspace packages and no
  React. Vite transpiles TSX through esbuild, so **no plugin is required**; none should be added
  for fast refresh.
- **The engine side is finished.** `@mapatlas/react` publishes `MapCanvas`, `EventComposer`,
  `TripReview`, `useTrackRecorder`, `useEventLog`, `useOfflineRegions`, `useTrackDraft` and
  `useTrackList`. `noopAnalyzer` and the `SensorSource` types are in `core`. **T7.1 is assembly,
  not construction**, which is the point: the demo existing at all is the evidence that the seams
  compose.
- **The demo has no app.** `apps/demo/src` imports nothing from `@mapatlas/react` despite
  declaring it. What exists is `/lab` — a fixture harness — plus T6.2's persistence control on the
  root route. There is no loop, no trip list, no storage wiring, no analyzer slot.
- **The vector-tile pipeline already exists.** `geojson-vt`, `vt-pbf`, `pbf` and
  `@mapbox/vector-tile` are pinned and used by `scripts/fixture/contour.mjs`; `s2-pmtiles` 1.1.2
  writes archives; `pmtiles` 4.5.0 reads them. A basemap extract is an extension of this, not a
  second toolchain.

## The upstream, which the survey had to answer

**Protomaps' OpenStreetMap basemap.** PMTiles, publicly readable without authentication, at zoom
0–15 — the fixture needs 8–14, so the range is covered. Licensed **ODbL as a Produced Work**,
requiring OpenStreetMap attribution. Two routes serve it: the daily bucket at
`maps.protomaps.com/builds`, and a Source Cooperative mirror at
`https://data.source.coop/protomaps/openstreetmap/`.

**Neither host is chosen here, because pinnability decides it and the two pull opposite ways.**
The survey first preferred the mirror on posture: Protomaps' documentation *discourages
hotlinking* and recommends copying tilesets to your own storage, and a bulk-access data
repository is the same posture as `s3://copernicus-dem-30m` in ADR-0024. **That reasoning was
incomplete.** The mirror carries *"the most recent daily build only"*, so it cannot be pinned at
all; the daily bucket retains *"all builds for the past week"* **and "the latest build for each
patch version"**, which is an address a named patch version can still be fetched from once it is
no longer current.

So the posture argument does not settle it, and the honest resolution is that **the hash is the
pin and the address is a lookup**: whichever route serves the named build, the build is
identified by its BLAKE3 hash, not by its URL. The hotlinking guidance is not violated either
way — reading a pinned build **once at build time** and writing it into a local archive is
copying, which is what Protomaps asks for; runtime hotlinking is what they discourage. Nothing is
fetched at runtime, exactly as in ADR-0024.

**A version mismatch to check before writing style layers.** The current basemap is **v4**,
compatible with `@protomaps/basemaps` style v4.0.0 and newer; the Source Cooperative mirror was
observed serving **v3**. Whether the layer schema differs between them is *not* stated in the
downloads documentation and must be established at increment time — because a layer list written
against the wrong version renders nothing and reads as a styling bug rather than a version
mismatch. Pin the version explicitly and write the demo's layers against that version's schema.

**Whether it can be cut with the pinned tools.** `pmtiles extract` is a Go binary and is *not*
proposed. The archive is range-readable over HTTP, and `pmtiles` 4.5.0's `PMTiles` +
`FetchSource` already does range reads — the same shape `scripts/fixture/source.mjs` uses against
the Copernicus COG. Reading the tiles covering the declared region and re-writing them with
`s2-pmtiles` needs **no new dependency and no new language**. *This is the survey's belief, not a
measurement:* the first increment that touches it must prove a round-trip before anything is
built on it, and if it fails, that is a finding to report rather than a reason to add a Go binary
without a ruling.

## Scope fence

**In:** the React shell at `/`, the record→pin→photo→review loop over published bindings, storage
wiring, the `noopAnalyzer` slot, a consumer `EventPresentation` with two neutral categories, the
basemap extract, and app-shell offline.

**Out, on the record:** a global basemap · tile-hosting infrastructure · a style editor · styling
beyond "recognisably a map" · the trip list and hand-drawn authoring (**T7.1b**) · the sensor
channel (**T7.1c**) · getting-started docs (**T7.2**) · eviction, quota and resume, which remain
unbuilt and unowned.

## Increments, and the argument for this order

The first three were one increment in an earlier draft — "the React shell and the loop" — which
is the whole acceptance criterion in a single handoff. **That is a granularity defect, not a
scope one**, and the review protocol is one increment per review: a monolithic first increment is
where a session builds for two days and hands over something nobody can review. Split by
observable, so each one can be judged on its own.

1. **The shell.** A React app at `/`, `MapCanvas` over the fixture stack, and storage wiring —
   `createIdbStorageAdapter` and `createIdbMapAssetStore`. T6.2's persistence control and
   installation guidance move into it, since they are the app's own settings. *Observable:* the
   app mounts, a map renders over the fixture archives, and the storage adapters open.
2. **Record → pin → photo → review.** `useTrackRecorder`, `EventComposer` with two neutral
   categories through a consumer `EventPresentation`, a photo attached, `TripReview` showing it,
   and the `noopAnalyzer` slot wired at the seam. *Observable:* a recorded trip carries an event
   with a photo, and the review renders it — each step asserted separately, since "the map drew"
   satisfies none of them.
3. **Export.** GeoJSON out, valid, preserving what the model carries. *Observable:* the exported
   file parses and round-trips.
4. **The basemap extract.** After the loop, because the loop does not depend on it: the fixture
   terrain and contours already render, and a demo that works over them is a demo. Doing it first
   would put the riskiest new pipeline in front of the criterion it does not serve.
5. **App-shell offline.** Last, and this is the ordering ruling: *the loop has to exist before it
   can be proven offline.* A precache worker written first would cache a shell nobody had checked.

If the survey during an increment finds a reason to reorder, it says why rather than reordering
silently.

## Bars for the app-shell increment

- **A precache worker over the built shell, and nothing else.** No runtime caching strategies, no
  update UX beyond a reload, no push, no background sync.
- **The worker never caches tiles or archives.** Map bytes come from `MapAssetStore` through
  T6.1's registrar. A worker caching `pmtiles://` responses would make the offline scenario pass
  for the wrong reason — precisely the vacuity T6.1's bar refuses. **The test asserts both**: an
  abort route on the archive URLs, *and* the worker's cache list not containing them.
- **A manifest and icons only as far as the AC needs.** Installability is **not** asserted —
  `CONTINUE.md`'s lesson 7 applies: a test that asks the platform whether the app is installable
  is testing the platform.
- **`react` and `react-dom` pinned exactly** in the demo, per T0.1's no-ranges rule for renderer
  dependencies, matching the root's `19.2.8`.

## Bars for the basemap increment

- **The same pipeline, not a second one.** Another archive under `build/fixture/`, cut at build
  time by `npm run fixture:build` from an upstream the build fetches, **never committed**.
  `CLAUDE.md`'s no-bundled-tiles rule is not reopened by this.
- **The extract is cut from one *pinned* build, never from "latest".** This is what the fixture
  build's own standard already demands: ADR-0024 pins the Copernicus release by ETag and size and
  reproduces its archive **byte for byte**. An upstream that moves daily makes "measured, not
  calculated" a moving target — the recorded size is wrong the next morning, and CI's extract
  differs from the one this plan measured. **BLAKE3 hashes are published per build**, so the build
  records version, date and hash the way ADR-0024 records the Copernicus ETag.

  > **Amended after the round-trip spike (increment 4, first commit).** This bar originally read
  > that the hashes are "verified with `b3sum`" and that the build "**fails if the upstream's
  > hash does not match**". That was written for a whole-file download and **cannot be met by a
  > range read**: verifying the published BLAKE3 means hashing 137 GB to cut 2 MB, which is not a
  > thing any build here will do. The wording promised an integrity check nobody would implement,
  > which is worse than a weaker check stated honestly.
  >
  > What is enforced instead, and is enforced *before a single tile is read*:
  > the build metadata row for the pinned key is fetched and its **size, `b3sum` and version**
  > compared with the recorded pin; every range response's **`Content-Range` total** is checked
  > against the pinned size, so a different archive served at the same URL fails on the first
  > read rather than round-tripping perfectly; and the **extract's own SHA-256** is compared with
  > a recorded constant, which is the byte-for-byte reproducibility ADR-0024 asks for, applied to
  > the artefact this build actually produces. Comparing a metadata row is **not** source-byte
  > verification and must not be described as such.
  >
  > Not SHA-256 out of preference: no `b3sum` is available in this toolchain and a hand-rolled
  > BLAKE3 would be worse than none. Over a 1.6 MB artefact the two answer the same question.
  >
  > **A size assertion on the extract would be a guard that guards nothing.** `s2-pmtiles` pads
  > the region before the tile data — header, root directory and JSON metadata — to a multiple of
  > 16 KiB, so deleting 7.5 KB of metadata leaves the file at exactly the same 1,604,280 bytes.
  > Measured, not assumed: `1,604,280 − 1,505,976 = 98,304 = 6 × 16,384`.

- **"Too old" is defined by the upstream's retention, not by a local guess.** The build date is in
  the key (`20260811.pmtiles`), and **the pin has aged out exactly when its row is no longer
  listed in the build metadata** — which the spike already fails on, by name. Retention is the
  past week plus the final build of each superseded patch version, so a pin on a *superseded*
  version's last build is stable while a pin on the current version's daily is not: `20260811`
  (v4.15.1) is pinnable, `20260907` (v4.15.2, current) is not. This is the coverage-snapshot
  precedent applied — the record carries a date, and the check is the upstream's own answer
  rather than an expiry someone has to remember to bump.
- **Licence decided per *named product* after reading its terms** (ADR-0024's method), with the
  declared strings checked verbatim against the documents through the existing `licence.mjs`
  rule, `offlineLicensed: true` because self-hosted, and attribution rendered verbatim.

  > **Amended after reading ODbL against this product (increment 4a).** This bar originally said
  > the licence was "handled exactly as Copernicus is" — *the archive carrying the licence
  > document* — and that "**ODbL means share-alike travels with the extract**", to be said in the
  > ADR in those words. Both were wrong for this product, and the ADR now says something
  > different rather than the promised phrase.
  >
  > The Copernicus archive carries its licence because that is what those terms require. ODbL
  > §4.2, which carries the "include a copy of this License or its URI" obligation, applies to
  > **Publicly Conveying a Database or Derivative Database**. Protomaps distributes this basemap
  > expressly as a **Produced Work**, and the tiles cut from it are one too — so §4.3 applies
  > instead, and it says in terms that *"Creating and Using a Produced Work does not require the
  > notice in Section 4.2"*, requiring an associated notice naming the source and the licence.
  >
  > **Share-alike is not an obligation this extract passes on.** §4.4 binds whoever creates a
  > *Derivative Database*; this extract is not one. Asserting it as something the archive carries
  > claimed an obligation on recipients that the licence does not place there — a claim in the
  > safe direction, which is still a claim nobody checked.
  >
  > What the archive carries instead is a compact notice: the credit `© OpenStreetMap
  > contributors`, an explicit ODbL notice, the source URI and the licence URI. The three
  > documents stay checked in as **provenance for the declaration**, which is what makes those
  > strings verifiable as quoted rather than recalled.
- **The licence documents still have to be named, because the mirror ships none** — they back the
  declaration even though the archive no longer carries them. `LICENSE` is 404
  there, and the README says only "Produced Works of the ODbL" with a link — but obligation 1's
  rule needs a checked-in document to compare strings against verbatim. The ADR entry therefore
  names them: the **ODbL 1.0 text from `opendatacommons.org`**, and the attribution line
  OpenStreetMap requires per `osm.org/copyright`. Both **fetched by a real route at increment
  time and never written from memory** — that is T4.6's lesson, and a licence string recalled
  rather than read is the one kind of error this repo cannot afford.
- **Cut to the declared region**, the same bounds as the fixture, and the size **measured, not
  calculated** (ADR-0024 criterion 6).
- **Round-trip through the pinned reader** (`pmtiles` 4.5.0) is the compatibility claim — as it
  was for `s2-pmtiles`. Not conformance to a specification.
- **Style layers are the demo's**, opaque to the engine (ADR-0011). The plan names how many layers
  the demo needs to look like a map and stops there: a basemap style is where a week disappears.
- **Provenance, per archive.** The offline scenario shows the basemap's bytes came from the
  store — an abort route on the extract's URL, and a deleted region failing to render it. Same
  bar as T6.1, applied to the new archive rather than assumed to carry over.

## What will be got wrong

**"The demo renders, therefore the loop works."** A screenshot of a map with a track on it is
satisfied by `/lab`, which has existed since T4.6 and discharges none of T7.1. The criterion is a
*loop*: record a trip, drop an event where it happened, attach a photo, review it, export it —
and each of those has an observable the render does not provide.

**"Offline" has three meanings here and they fail independently.** Map data offline is Phase 6's
and is done. App-shell offline is new. **User-data offline was never a network concern at all** —
recording writes to IndexedDB and has never needed the network — so a test that cuts the network
and watches a recording succeed is asserting something that was always true. Each has to be
observed on its own terms; passing one does not carry the others.

**A reload test that reloads too early.** "Survives reload" means the data was durable *before*
the reload, not that a write completed during it. The assertion has to name what was persisted
and read it back after a genuinely new document, in the way T6.1's positive control needed a
fresh realm rather than a re-mount.

**An analyzer slot that proves nothing.** Swapping `noopAnalyzer` for a stub has to be observable
in the review — the criterion is *"zero core changes"*, so the evidence is that the swap happens
at the seam and no file under `packages/core` differs. `git` is the oracle for the second half.

## Required mutations

- the worker caches an archive URL → the offline scenario passes for the wrong reason, and the
  cache-list assertion is what catches it;
- the worker is registered but precaches nothing → the shell fails to load offline;
- the offline scenario reloads without a fresh document → a stale in-memory state satisfies it;
- the basemap extract is cut to the wrong bounds → the region renders empty where the fixture
  archives render;
- the extract's archive is served from the network rather than the store → the per-archive
  provenance assertion fails;
- attribution is dropped from the rendered map → the licence check fails, as it does for the DEM;
- the analyzer is called from inside `core` rather than through the seam → the zero-core-changes
  claim fails as a diff, not as a test.

## Backlog — found while building, deliberately not fixed here

- `e2e/fixtures/serve-lab-archives.mjs` exits on `GET /` with an unhandled `EISDIR`: it streams
  the requested path without checking it is a file, and the directory read throws where nothing
  is listening for it. Only a request for the server's root reaches it, which no scenario makes
  and a human opening the host does — so it costs a reviewer a crashed archive server and costs
  the suite nothing. Its own fix, not this increment's.
