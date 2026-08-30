# T4.6 — vertical acceptance fixture: implementation plan

Derived from `specs/tasks.md` (T4.6) and ADR-0024. Where this plan and those disagree, they
win and this is stale. Claims below are marked **[verified]** when checked in-repo or against a
dependency's source this session, and **[to verify]** when they are expectations that must be
confirmed before they are built on. Nothing here is marked verified on the strength of
recollection.

## Status — read this before any progress claim

Four levels, because collapsing them is how a series of true green reports adds up to a false
impression. **Nothing below has been run against real data end to end**: the build orchestrator
has never touched a network or a filesystem, and every integration test drives it through
injected fakes.

| | unit-tested | wired into `build.mjs` | discharged end-to-end | notes |
| --- | --- | --- | --- | --- |
| Terrarium codec | yes | yes | **no** | never run on a real COG's pixels |
| Region declaration + floor (ob. 4) | yes | yes | **no** | never run on decoded real tiles |
| Coverage + gap classification (ob. 2, 3) | yes | yes | **no** | probe is injected; never run against S3 |
| Licence rule (ob. 1) | yes | yes | **no** | strings now sourced; never run on a real archive |
| Build ordering | yes | — | **no** | no writer and no tile reader behind the seams |

**Remaining T4.6 implementation scope**, none of it implemented or integrated — investigation
has happened, which is why the writer and toolchain sections below carry evidence: the
GeoJSON→MVT contour toolchain; the PMTiles writer (`s2-pmtiles` is well-evidenced but
uncommitted and unconfirmed at fixture scale); a real tile reader; producing an actual
archive; measuring its size (ADR-0024 criterion 6); the fixture track (≥5k points, two-segment
pause, two event marks); the `/lab` route; simulated GPS; the offline Playwright scenario; and
the frame-time and memory baseline. That is most of the task by volume.

**On verification claims in this plan and in commit messages:** gate runs and mutation results
are *author verification* — real and reproducible, but run by whoever wrote the code, not an
independent check. Where a claim was confirmed by someone else, it says so.

## What ships

1. `scripts/fixture/` — the build and its four obligations, each module injectable so the
   ordering is testable without a network. `build.mjs` cuts a PMTiles archive from Copernicus DEM GLO-30
   Public for one declared region: terrarium-encoded elevation, plus a vector contour layer
   derived from the same grid.
2. `fixtures/vertical/` — the region declaration, the licence artifacts, and the recorded track.
3. A Playwright scenario that renders the stack with the network disabled.
4. `/lab` in `apps/demo` — the same fixture, human-openable, with a simulated GPS mode.

## The four obligations, and the check that discharges each

Every one **fails the build**. None warns. Each row names the failure a reader would see, since
an obligation whose failure is unreadable gets debugged as something else.

| # | Obligation | Check | Failure names |
| --- | --- | --- | --- |
| 1 | Licence strings checked **and** written into the archive | Two halves, as `specs/tasks.md` states them. Every declared string must occur verbatim in the checked-in licence document; and every declared string must be emitted into the archive, alongside the document itself carried as `LICENSE` | the role, where it diverged, and what the archive held instead |
| 2 | Released coverage, per tile | Every tile in the cut is read; a read that finds nothing is a gap | the tile: `no published tile at N45E007` |
| 3 | A gap fails rather than fills | No fill path exists in the encoder — the absence of a branch, not a guarded one | as (2) |
| 4 | Region is above the treeline | The cut's lowest decoded sample is compared against the region's declared `minElevationM` | the sample, its tile, and the declared floor |

### Obligation 1 is built; its inputs are blocked upstream

**Two changes to this obligation are recorded here rather than quietly absorbed**, because both
were made while writing the code and would otherwise read as the original intent.

*The bar was loosened from byte-for-byte to verbatim-modulo-whitespace-runs.* An earlier version
of the row above said byte-for-byte; `normaliseWhitespace` collapses whitespace runs on both
sides. The reason is good — a licence document wraps its lines, so a sentence spanning a break
would never match a single-line declaration, and requiring the declaration to reproduce the
source's line breaks would make it fail on reflowing rather than on meaning — but it is a
loosening, decided during implementation, and calling it "verbatim" without saying so would let
the plan track the code. Case, punctuation and wording remain exact.

*The archive half was briefly dropped and is restored.* A rewrite of the row above narrowed it to
the `LICENSE` file alone, which left half the obligation unbuilt **and** unnamed — the worst
combination, since nothing was left to notice the gap. `specs/tasks.md` is authoritative and
names both halves.

The rule is implemented and tested: every declared string must occur verbatim in the licence
document, all four roles the ADR names must be declared, and the archive must carry the document
itself. Whitespace runs collapse on both sides — a licence wraps its lines, and requiring a
declaration to reproduce those breaks would fail on reflowing rather than on meaning — and
nothing else is normalised, case included, since lower-casing an organisation's name changes who
a notice names. A failure reports where the string stopped matching rather than only that it
did, because "not found" sends a reader to compare two documents by eye.

The archive half asserts that every declared string is emitted **outside** the `LICENSE` entry.
That exclusion is the check: the strings are drawn from the licence, so scanning an archive that
carries the licence would find all of them inside it and pass with no credit emitted at all —
satisfied by the presence of the very thing it is meant to be independent of. It was written the
vacuous way first and caught by a test that expected a failure and got none. It says nothing
about *where* attribution lives, since that is metadata layout and belongs to the undecided
writer; it asserts over the same `entries()` surface the licence check already uses.

**[resolved 2026-08-30] The strings are sourced, and the blockage was partly my own design.**
The authoritative text is Article 6 of *Licence for Copernicus DEM instance COP-DEM-GLO-30-F*,
fetched from `documentation.dataspace.copernicus.eu` — a different host from the one this plan
had recorded as unreachable. Three probes of a single URL supported a claim about a host and
were written up as a claim about the document; the licence was reachable the whole time by
another route. `fixtures/vertical/licence/` holds the extracted text with its manifest (source
URL, PDF sha256, retrieval date, extraction command, text sha256), and
`fixtures/vertical/attribution.json` holds the four roles **sliced from that text by script,
never typed**, so no transcription error is possible at creation.

**The licence gate has moved from execution to distribution**, which is the more important
correction. The obligation is about redistributing a derived work, so it belongs where an
archive becomes downloadable. Gating every run on it meant a missing legal string blocked the
writer, the tile reader and the contour source, none of which redistribute anything. A
`distributable: false` build now skips the licence stage, writes to a `.dev` path and must carry
a `NOT-FOR-DISTRIBUTION` marker; a distributable build cannot skip it by any flag. That is a
trade of one obligation for another, not an escape hatch.

Superseded, retained for the record: the strings were previously absent. ADR-0024
quotes the derived-works notice verbatim but only *describes* the liability and
downstream-binding sentences, and the authoritative document is currently unreachable:
`spacedata.copernicus.eu` failed to connect at 45 s and again at 90 s while the AWS bucket
answered 200 in the same session, so it is the licence host rather than connectivity. The bucket
carries no `LICENSE` object (404) and its `readme.html` defers to that page rather than
reproducing the terms.

Writing those sentences from memory is the exact failure this obligation exists to catch, so
they stay unwritten. The suite tests the rule against a synthetic licence for a second reason
beyond the blockage: a checker tested against the text it will check would be asserting that a
constant equals itself.

### Obligation 3 is a different category of assurance from the other three

The other three are checks: code that runs, compares, and throws. Obligation 3 is discharged by
**the absence of a fill path** in the encoder — nothing to relax, because nothing is there. A
guard around a fill can be loosened under deadline pressure and will look reasonable in the diff
that loosens it; a path that does not exist has to be written before it can be wrong. That is the
form that survives a bad week, and it is worth preferring wherever a check and an absence are
both available.

It also changes what the test asserts. Not "does the guard fire", which presumes a guard, but
**does a gap reach the encoder and terminate the build**. That phrasing covers the case nobody
anticipated — a decode error, a truncated read, a tile that is present but unreadable — because
the failure is the same one either way, rather than one the guard was written to recognise.

**A second, independent leg under the same claim.** The absence of a fill path is one support;
the other is that the pinned reader already distinguishes absent from present without a
sentinel — a tile never written reads back as `undefined`, not as empty data, verified in the
round-trip below at every archive size and in both compression modes. That matters because the
two legs fail independently: if someone later adds a fill path, the reader's behaviour still
makes a filled tile distinguishable from an absent one at read time, and if the reader ever
changed, the missing fill path would still make the build fail rather than produce a wrong
archive. Two supports under the property this task cares about most, and worth stating here
rather than only in the writer notes, where it would read as a detail about a dependency.

### Obligation 2 is the only one that depends on a fact about the world

The other three are testable against fixtures this repo constructs: a licence document with a
drifted string, a synthetic tile carrying a sample below the floor, a deliberately absent tile.
Each fails deterministically with no network.

Coverage cannot be. **Recommendation: the build's own read is authoritative, and the published
tile list is a checked-in snapshot that is advisory.** The reasoning:

- The build range-reads S3 already (ADR-0024, criterion 7), so a withheld tile is discovered for
  free as a read that finds nothing. Detection never needed a list.
- What a list adds is **classification** — and measurement on 2026-08-30 narrowed what that
  means, because the first version of this bullet was too strong. Absence presents as an HTTP
  **404** (`N90E000` and `N00E000` both 404; `N45E006`, `N45E007`, `N46E006`, `S90W180` all 200),
  and a 404 is already distinguishable from a 5xx or a timeout. So the transport layer separates
  "not there" from "the fetch broke" without any list.

  What it cannot separate is an **expected** 404 from an **unexpected** one, and those demand
  opposite actions: a tile GLO-30 Public never published means "choose another region", while a
  404 for a tile the snapshot says exists means the URL scheme, the bucket layout or the release
  has changed — retrying is futile and re-picking the region is wrong. That distinction is what
  the snapshot buys, and it is why detection being free does not make the list optional.
- So the snapshot records a **decision input** (was this region viable when it was chosen?)
  rather than caching a dependency the build's correctness rests on. A stale snapshot yields a
  less helpful failure, never a wrong archive.
- It therefore carries a retrieval date **and** a maximum age that fails the build on its own,
  because a date alone asks the reader to judge staleness with no basis. The age is generous —
  GLO-30 Public's withheld set is a published policy, not a live service's availability — and
  being generous costs nothing precisely because the snapshot is not load-bearing.

## Region selected by the process, not assumed into the plan

**[verified 2026-08-30]** `fixtures/vertical/region.json` declares the Mont Blanc summit cut:
`[6.825, 45.815, 6.905, 45.865]`, wholly inside source tile `N45E006`, with a 2,500 m floor.
Pecher, Tasser and Tappeiner report mean potential-treeline elevations of 2,200–2,350 m in the
central European Alps (2011, https://doi.org/10.1016/j.ecolind.2010.06.015), so the declared
floor sits above the top of that reported range rather than choosing a threshold from the DEM
it is meant to judge.

The public 2021 GLO-30 COG existed at selection time (42,310,635 bytes; ETag
`72c5ebd9d8a7e37b8843109b5a40978b`; a one-byte range GET answers **206**, which is why coverage
accepts 200 and 206 and nothing else). A full-resolution crop over the declared bounds measured
2,560.8–4,810.7 m: it clears the floor with a deliberately finite margin, is inland and has enough
relief to make terrain, hillshade and contours visible. A `HEAD` on that object returned 200, which is
direct evidence that the one tile this cut needs is published — but it is **selection evidence,
not a discharge of obligation 2**. The build repeats the coverage check every run, because a
tile published at selection time is a fact about then, and the snapshot remains necessary
regardless: it is what separates an **expected** 404 from an **unexpected** one. Transport
failures need no list — a 5xx, a timeout or a thrown probe is already distinct from a 404 — so
the snapshot's job is narrower than an earlier version of this paragraph claimed, and it is the
job detection genuinely cannot do.

**Coverage snapshot provenance**, so the derivation is checkable rather than asserted. Upstream
`https://copernicus-dem-30m.s3.amazonaws.com/tileList.txt`, read 2026-08-30: **1,110,900 bytes**,
ETag `637fe75ddf7615ba853dd83caf05cd82`, 26,450 lines of the form
`Copernicus_DSM_COG_10_N45_00_E006_00_DEM`. The checked-in list is that file normalised — CRs
stripped, each line reduced to its eight-character cell id by
`s/^Copernicus_DSM_COG_10_([NS][0-9]{2})_00_([EW][0-9]{3})_00_DEM$/\1\2/`, non-matching lines
dropped, then `sort -u` — giving 26,450 ids in 211,600 bytes. The manifest's sha256 proves the
local pair agrees with itself; these three figures are what tie it to upstream, since a digest
of the normalised file cannot.

"Inland" is discharged here too, and by these same checks rather than a fourth: the cut requires
only published tiles and every sample clears a 2,500 m floor, so no ocean pixel can be present.
That enforces no ocean intersection, not distance from a coastline.

This measurement selects the region; it
does not discharge the build obligation. The build still computes the lowest decoded sample and
fails against the declaration every time, so a later source or bounds change cannot inherit the
selection-time answer.

## Contours

The engine only styles contours — `styleLayers` is an opaque passthrough (ADR-0011) **[verified:
`packages/maplibre/src/builders/tile-source.ts`]** — so this script generates the geometry, which
is why criterion 4 is live and why the region is constrained.

Proposed toolchain, chosen to avoid a system dependency so CI stays reproducible: decode the
terrarium grid, trace isolines with `d3-contour`, emit GeoJSON, tile it, and write MVT.

**[author-verified 2026-08-30, scratchpad only] The GeoJSON→MVT tiling stage passes both
recorded bars.** Candidate chain, pinned: `geojson-vt` 4.0.3 (ISC) → `vt-pbf` 3.1.3 (MIT), with
`extent` 4096, `buffer` 64 and the default `tolerance` 3; decoded for checking with
`@mapbox/vector-tile` 3.0.0 and `pbf` 5.1.2 (whose v5 surface exports `PbfReader`/`PbfWriter`
rather than a default). Pure npm, no system dependency.

*Bar 1 — seam continuity: pass.* A line crossing the z14 seam at lon 6.8774414 between tiles
`14/8504/5839` and `14/8505/5839`. The two tiles cross the seam at latitudes 45.839999084 and
45.839998706 — a gap of 3.78 × 10⁻⁷ ° (4.2 cm), **0.071 of one quantisation unit** (5.36 ×
10⁻⁶ °). Measured by interpolating where each tile's line meets the seam, not by looking for a
shared vertex: the input's midpoint is collinear and simplification correctly removes it.

*Bar 2 — small-loop survival: pass, on topology rather than presence.* Four square rings
(0.02°, 0.008°, 0.003°, 0.001°) across z10–z14, perceptibility threshold 4 px at 256 px/tile.
Every perceptible ring — and every sub-threshold one — reconstructs as exactly **one** connected
cycle with all vertices at degree two, feature type `Polygon` throughout, and area within 0.8% of
the input. Rings crossing seams reassemble from 2 or 4 tile fragments into a single cycle.

*Reconstruction method*, since presence of a tagged feature proves nothing about topology — a
tagged feature can survive as clipped fragments, an open path, or a degenerate line, which are
the failures the bar names. Each decoded fragment is clipped to its own tile's square in extent
space (Liang–Barsky) so the render buffer is discarded; segments lying along a tile edge are
dropped as clip artefacts; the remainder is converted to common world coordinates, deduplicated
on a two-quantisation-unit grid (0.125 px at extent 4096, well below the recorded 4 px perceptibility threshold), and
assembled into a graph. One closed cycle requires every vertex at degree two, one connected
component, and nonzero shoelace area.

**[2026-08-30] Both bars hold on real `d3-contour` geometry from the declared crop — Bar 1
author-verified, Bar 2 independently verified.** Only the loop-topology question was handed over:
a frozen harness with raw decoded fragments, adjudicated by a second oracle — Shapely 2.1.1 /
GEOS 3.13.1, polygon union over global integer extent coordinates, using none of this probe's
graph, snapping grid or vertex keys. Bar 1's seam figures below come from this probe and remain
author verification.

*Real-data controls:* the crop reproduces exactly — 51,840 samples, 0 non-finite,
2,560.8–4,810.7 m. `d3-contour` 4.0.2 over 23 predeclared thresholds (2600–4800 by 100,
probe-only) yields 31 exterior rings, no holes.

*Bar 1 on real geometry:* **0** crossing-count mismatches across every internal seam at z10–z14
(52 to 298 crossings per zoom), mean gap 0.006–0.098 quantisation units, max 2.085 ≈ 0.13 px.

*Bar 2 on real geometry:* **0 topology failures across all 128 perceptible feature/zoom cases**,
every one reconstructing as a single valid, nonzero Polygon with one component and no unexpected
holes — **with a repair step that is part of the result, not a detail of it.** The oracle
classified MVT ring winding and applied GEOS `make_valid` to 41 invalid decoded rings *before*
clipping to the tile core and unioning. Without that step, direct clipping and union produces six
apparent topology failures, while the area-fidelity count is inflated from ten to eighteen — the
repair affects the two predicates differently, and stating one number for both would make it look
as though repair erased the area finding. It does not: the topology zero is a property of
ring-classification-then-repair-then-union rather than of union alone, and ten genuine
area-fidelity breaches survive the repair. GEOS reported each of those 41 rings' invalidity at a point on the ±64 buffer
boundary, outside the tile core; that is one reported location per ring, not an enumeration of
every self-intersection, and no source contour was invalid.

The case this probe had flagged, `t3000_p0`, needed **no** repair — its 19 fragments were already
valid — and reconstructs with an area error of **−0.000064%**, symmetric difference 0.01064%,
Hausdorff distance 0.293 px.

**A qualification that must not be dropped when this is summarised.** The synthetic evaluation's
≤0.8% area agreement is *not* a universal property of real data: 10 of the 128 cases exceed it,
to a maximum of 6.54%. Those are small contours, 4.11–12.06 px wide, topologically intact, with
maximum boundary displacement across the whole set of 0.303 px. So the accurate record is
**real-geometry loop topology passes; universal ≤0.8% real-data area fidelity does not.** Bar 2
is discharged as presently specified — one connected degree-two cycle with nonzero area — and
would not be if area fidelity were promoted into the requirement.

**Five instrument faults, and the last one is the transferable lesson.** This probe's own
measurements produced false failures five times: rings identified by measured width; seam
continuity sought as a shared vertex that simplification had legitimately removed; a stitch that
dropped the buffer box while keeping the buffer overlap; two different snapping resolutions
between edge dedup and the cycle graph; and finally — **a grid key is not a proximity test**.
Two points 1.672 units apart in a two-unit grid round into adjacent cells and never merge, which
is why coarsening the grid made matters worse rather than better. Rounding-to-a-cell and
distance-within-a-tolerance are different predicates, and this probe used the first while
reasoning about the second. Every one of the five produced the same signature — an open chain
with negative area error — which is why the residual could not be attributed from inside.

**What this does not establish.** The evaluation exercises the *tiling stage*. Explicitly
outstanding: fixture scale; adoption of any of these packages as dependencies, which has not
happened and is not proposed here; and integration into the build, where the contour source
remains unwritten. `d3-contour`'s output and real DEM-derived geometry were outstanding until
the real-geometry probe above and are no longer. The status table is unchanged regardless: an
evaluated tiling stage is not a built contour source, and nothing here moves an obligation to
*discharged*.

The **synthetic** evaluation described in this subsection is author verification: the chain was
selected and the test that judges it was written by the same author. Its real-geometry successor
above was adjudicated independently for Bar 2, and the five instrument faults are recorded there.

**[verified: negative] `pmtiles` 4.5.0 cannot write.** Its published type surface carries no
write, serialize, or encode entry point — `bytesToHeader` parses a header and nothing emits one;
the exported classes are `PMTiles`, `Protocol`, the two sources and the caches. It is a reader,
and the archive must be produced by something else.

That does **not** open the question of whether the archive can be built once and committed
instead: `CLAUDE.md` forbids bundled map tiles in the repo, so the archive is a build artifact in
every design. **The two are independent** — the guardrail closes the committed-archive branch for
a reason that has nothing to do with what can write PMTiles, so finding a JS writer later does
not reopen it. A reader who discovers one should change the build step and leave the
repository's shape alone. What the negative result narrows to is two questions, neither of which is the ADR
the plan expected:

1. *Which writer.* **[verified: `s2-pmtiles` 1.1.2 passes bar one at small scale]** — the only
   npm package in the registry that writes PMTiles rather than reading it. MIT, last published
   2025-12-22, one transitive dependency (`fflate`, already shared with `pmtiles`), from Open-S2
   rather than Protomaps — so the compatibility claim rests on the round-trip below and not on a
   shared codebase. `S2PMTilesWriter` takes a `Writer` sink plus a tile type and compression, and
   exposes `writeTileXYZ` and `commit(metadata)`.

   The round-trip: four tiles across three zooms written by `s2-pmtiles`, read back by `pmtiles`
   4.5.0. All four returned their exact bytes; the header parsed as spec version 3 with the tile
   type, zoom range, compression and clustered flag intact; `commit`'s metadata survived; and a
   tile that was never written read back as `undefined` rather than as empty data — which is the
   behaviour obligation 3 depends on, since it means the reader distinguishes absent from present
   without needing a sentinel.

   **Leaf directories, which four tiles could never reach, are covered too.** Four tiles is one
   root directory; past a 16 KB bound the writer emits leaf directories, and that is where two
   independent implementations of a spec are most likely to diverge precisely because a small
   archive never exercises it. Measured rather than estimated, and the threshold is
   **compression-dependent**:

   | | leaf threshold | tiles written | leaf dir | root dir | tile / internal compression | sampled reads | absent tile |
   | --- | --- | --- | --- | --- | --- | --- | --- |
   | none | 3,132 | 3,182 | 16,365 B | 6 B | 1 / 1, as requested | all ok | `undefined` |
   | gzip | 7,558 | 7,608 | 15,884 B | 32 B | 2 / 2, as requested | all ok | `undefined` |

   Sampled reads cover the first, second, early, middle and both final tiles — the last of which
   resolve through a leaf rather than the root. Compression is asserted **from the header**, not
   inferred from the payload: a writer that sets the field wrongly and a reader that ignores it
   fail differently, and one of them presents as data corruption.

   **The trap, recorded because the next person will walk into it.** Compression moves the
   threshold — the same compression that shrinks tiles shrinks the directory — so a run that
   applies the uncompressed threshold to a gzip archive builds no leaves at all while looking
   like a leaf-directory test. The first attempt here did exactly that, and it surfaced only
   because `usesLeafDirectories` was asserted rather than assumed from the tile count. **Compute
   the threshold per compression mode**, and assert the flag.

   Sizing: crossing the threshold with room beats going to fixture scale. The sharp archive is
   150 KB and builds in well under a second, so this belongs in CI rather than being a one-off;
   fixture scale then confirms rather than discovers.

   Incidental, and a real finding for whoever runs this next: `pmtiles`' own `FileSource` is
   browser-`Blob` shaped — it calls `.slice().arrayBuffer()` — so reading an archive from Node
   needs a small `Source` over `fs`, about six lines. Worth knowing before the first run rather
   than after it: it throws `this.file.slice(...).arrayBuffer is not a function`, which reads as
   an incompatibility between the two packages and is not one.

   The two bars, set before looking so that what turned up did not set them:
   - **Round-trip through the pinned reader**, not conformance to the spec. Independent
     implementations agreeing on a spec version is the claim; an archive written by the
     candidate and read back by `pmtiles` 4.5.0 — the version that actually ships — is the
     evidence. Cheap, and the only compatibility statement that matters.
   - **A system tool is priced as a pinned binary, not as "a system dependency"** — now the
     fallback if the scale re-run fails, rather than the expected answer. For a Go
     release that means a pinned version fetched by the build, not a package-manager default
     that drifts per runner image. The cost is real and bounded; the abstract phrasing makes it
     sound worse than the pinned form is, and would bias the choice before it is made.
2. *Who runs it, and when.* CI legitimately has a network at build time (ADR-0024, criterion 7
   already puts S3 there); it is the **runtime** that must have none. So building in CI is
   permitted, and the choice between building per run and caching the artifact is a cost
   question rather than a correctness one.

The reproducibility-versus-dependency trade the plan anticipated therefore does not arise in the
form it was written.

**Second time in this task, and the mechanism is worth naming.** First the 3DEP branch, now this.
Deferral is normally justified by cost — the decision looks expensive, so it is postponed — and
that same estimate is what suppresses the cheap check, because an agreement not to answer a
question reads as an agreement not to look at it. The deferral is then self-sustaining: the
question stays expensive precisely because it stays unexamined, and the cheapest move available
is the one the framing discourages. Acted on here as a rule: **when something is marked blocked,
verifying that the blocking condition is real is the first move, not a later one.**

## Fixture composition

Per T4.6: a track of ≥5k raw points with a two-segment pause, two consumer-defined event marks,
a DEM + hillshade + contour source stack, and the archive persisted locally. Generated
deterministically from a seed so the archive and the track are reproducible, and shared between
the Playwright scenario and `/lab` rather than duplicated.

## `/lab` and simulated GPS

Reached through the packages' public entry points, so it exercises what a consumer imports;
`e2e/harness` stays automation-only. Simulated GPS replays the fixture track through the same
`TrackRecorder` seam the browser implementation satisfies, so the demo is operable from a desk.

## Acceptance

Renders with the network disabled; the pause shows as a gap; frame time and memory recorded as a
baseline. The baseline is a recorded number, not a threshold — its purpose is to make a later
regression visible, and a threshold picked now would be invented.

## Open, and not to be resolved by assumption

Ordered by what gates what.

1. **The contour toolchain beyond its tiling stage.** The candidate evaluation is done, on
   synthetic geometry under author verification and then on real `d3-contour` output from the
   declared crop, with Bar 2 of the latter adjudicated independently — both bars pass, recorded
   in the contours section above with the measurements. What remains open is what neither run touched:
   **adopting any of those packages as dependencies**, which has not happened and is a separate
   decision; **fixture scale**; and **integration into the build**, where the contour source is
   still unwritten and `writeArchive` has nothing behind it.

   Carried forward as a constraint rather than a result: the synthetic run's ≤0.8% area
   agreement does **not** hold universally on real data — 10 of 128 cases reach 6.54%, all small
   contours 4.11–12.06 px wide and all topologically intact. Bar 2 is discharged as specified,
   on topology; it would not be if area fidelity were promoted into the requirement, and that
   decision should be made deliberately rather than inherited from the synthetic figure.

   The two bars stay recorded because the measured behaviour **must be preserved by the
   integrated build** — adopting these packages and wiring a real contour source into
   `build.mjs` are where it could be lost:

   - **Seam continuity.** Coordinate quantization at tile boundaries leaves contour lines that
     do not meet across the seam. A single tile renders perfectly; the defect exists only
     between adjacent tiles.
   - **Small-loop survival.** Simplification at low zoom closes or drops small closed contours —
     a knoll or a hollow vanishing, or worse, becoming a line. Again invisible in isolation.
     A ring count alone says rings were dropped, not whether the right ones were: rings present
     at z14 and absent at z10 is correct behaviour. So the comparison basis is fixed — **a
     closed ring must survive at every zoom where its own extent is still perceptible** — and
     survival means one connected degree-two cycle with nonzero area, not a feature bearing the
     right tag. The pixel figure is set with the fixture's line width and target display.

   Both share the leaf-directory shape, and the shape has a tell worth naming: **when a
   property's statement contains a relational word — meets, matches, survives across, agrees
   with, continues into — the unit under test is the pair, not the thing.** No amount of testing
   individual artifacts reaches a property that lives between them. Three instances in this task
   alone: leaf directories versus a root-only archive, seam continuity between adjacent tiles,
   and the pointer and DOM lanes agreeing on which vertex is under a tap. Each was invisible to
   a test that looked complete.

   So the check crosses the boundary deliberately — adjacent tiles reconstructed together and
   compared at the seam, closed cycles counted per zoom rather than one tile eyeballed. Deciding
   that before a candidate's output was on screen is what stopped the output from setting the
   bar, and it is why five successive false failures were legible as instrument faults rather
   than as results.
2. **Archive size** — answerable only from a real assembled archive, so it waits on full-chain
   integration: the writer adopted, the contour source written, real tiles cut. ADR-0024
   criterion 6 requires the result **measured** rather than calculated, and there is nothing to
   measure until the chain produces one.

**Status of the writer, stated precisely so a summary cannot round it up.** `s2-pmtiles` is a
well-evidenced candidate, not yet a committed dependency. Verified: the API shape, a four-tile
round-trip, and leaf directories past their threshold in both compression modes with the header
fields asserted. Not verified: the same at fixture scale with real raster terrarium payloads of
tens of kilobytes rather than fifteen-byte strings — which moves tile counts and archive size,
though it should not move directory structure. That remaining run is **confirmatory rather than
exploratory**, and the distinction is worth keeping in both directions: calling it outstanding
overstates the risk, calling the question answered understates it.
