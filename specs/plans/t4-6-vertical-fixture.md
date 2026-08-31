# T4.6 — vertical acceptance fixture: implementation plan

Derived from `specs/tasks.md` (T4.6) and ADR-0024. Where this plan and those disagree, they
win and this is stale. Claims below are marked **[verified]** when checked in-repo or against a
dependency's source this session, and **[to verify]** when they are expectations that must be
confirmed before they are built on. Nothing here is marked verified on the strength of
recollection.

## Status — read this before any progress claim

Four levels, because collapsing them is how a series of true green reports adds up to a false
impression. **No committed path has produced a real archive, and no row below is discharged.**
The orchestrator's fetching seams are bound to the real source and a scratchpad run has driven it
against S3 and a real COG — so the older statement here, that it had never touched a network, is
no longer what makes the column read "no". What makes it read "no" is that the archive stage is
still a fake writer, nothing is written, no committed path reproduces that run, and every suite
drives the build through injected fakes.

| | unit-tested | wired into `build.mjs` | discharged end-to-end | notes |
| --- | --- | --- | --- | --- |
| Terrarium codec | yes | yes | **once** | real COG pixels through the whole chain into a real archive |
| Region declaration + floor (ob. 4) | yes | yes | **once** | real decoded samples cleared the 2,500 m floor at 2,560.80 m |
| Coverage (ob. 2) | yes | yes | **once** | both cells probed against S3 and admitted before any read |
| Gap rule (ob. 3) | yes | yes | **once** | no fill path exists, and an unwritten tile reads back `undefined` from the real archive |
| Licence rule (ob. 1) | yes | yes | **once** | checked against the real document *and* the real archive's own metadata |
| COG source reader | yes | yes | **once** | bound behind `readTile` by `deps.mjs` |
| PMTiles writer | yes | yes | **once** | 1.49 MB archive, read back by `pmtiles` 4.5.0 |
| Mercator addressing + envelope | yes | yes | **once** | coverage now runs over the envelope |
| Bilinear resampler | yes | yes | **once** | 8 distinct PNG tiles |
| Stitched source surface | yes | yes | **once** | two real cells joined across 7°E |
| PNG serialiser | yes | yes | **once** | every tile in the archive is a PNG |
| Build ordering | yes | — | **once** | all stages ran in order against real inputs |

**"once" is not "yes", and the gap is reproducibility.** Every obligation above has been met, end
to end, against the real release — but by a **scratchpad runner**, so nothing in the repository
reproduces it and CI cannot. A committed entry point is the next increment, and until it exists
these rows say what happened rather than what a reader can re-run.

**The chain produced a real archive on 2026-08-31.** `mont-blanc-summit`, source cells
`N45E006` **and** `N45E007`, envelope 6.679–7.032 °E against a declared region ending at 6.905,
lowest sample 2,560.805 m, 8 tiles, **1,493,696 bytes**, in 8.3 s. Verified through `pmtiles`
4.5.0 over the hardened range path: spec v3, PNG, z11–12, clustered, `bounds` equal to the
declared region, all four attribution roles present, 8 of 8 tiles found with 8 distinct payloads,
and an unwritten address reading back `undefined`. That measurement discharges ADR-0024
criterion 6, which requires archive size **measured** rather than calculated.

**Remaining T4.6 implementation scope.** The source reader is built and is now bound behind
`readTile` (see *The source reader* and *The async wiring* below). Still outstanding: the GeoJSON→MVT
contour toolchain; the PMTiles writer (`s2-pmtiles` is well-evidenced but uncommitted and
unconfirmed at fixture scale); producing an actual archive; measuring its size (ADR-0024
criterion 6); the fixture track (≥5k points, two-segment pause, two event marks); the `/lab`
route; simulated GPS; the offline Playwright scenario; and the frame-time and memory baseline.
That is still most of the task by volume.

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

## The source reader

**[verified 2026-08-30] Built, unit-tested, and run against the real object — standalone.**
`scripts/fixture/source.mjs` range-reads a GLO-30 COG, crops it to the declared bounds and
terrarium-encodes the samples. Nothing in `build.mjs` calls it yet, so it discharges no
obligation; what it does is remove the reason the elevation stage had nothing behind it.

**No GeoTIFF dependency, because the format turned out not to be the hard problem it looked
like.** `N45E006`'s IFD, read from a 64 KB range: little-endian classic TIFF, 3600×3600, one
float32 sample per pixel, compression 8 (deflate) with predictor 3 (floating point), tiled
1024×1024, EPSG:4326, `RasterPixelIsPoint`, 1 arcsec spacing, tied at (6, 46). Decoding that is
`node:zlib` plus the predictor's inverse. A general reader would have been a dependency whose
value is precisely the formats this build must refuse, so every structural assumption is
asserted instead and names the tag that diverged — an upstream format change fails loudly rather
than being accommodated into a wrong surface.

*The real-data control.* The reader reproduces the crop figures this plan already records from a
separately written probe: **288 × 180 = 51,840 samples, 0 non-finite**, spanning
**2,560.80–4,810.72 m** — the reader's own figures are 2,560.8046875 and 4,810.71875, those
values quantised to the encoding's 1/256 m step, which is the terrarium round trip and not a
discrepancy. It reads **3 ranges totalling 3.9 MB** of a 42 MB object in ~2.4 s: the header
window, then the two internal tiles the crop overlaps. That the figures match a probe written
from different code is corroboration; that this reader was written from the TIFF specification
rather than from that probe is why it is worth anything.

*The silent failures, checked.* Every other divergence here is loud. Three are not, and each is
guarded because it would otherwise produce a plausible surface rather than an error.

- **The wrong object.** It decodes perfectly and puts correct-looking terrain in the wrong place.
  The reader cross-checks the file's tiepoint against the corner the tile id names, and
  `parseTileId` lives beside the `tileId` that formats it, round-tripped over the **whole**
  64,800-cell grid as a pair — "inverts" is a relational property, so the unit under test is the
  pair, not either function.
- **A crop edge that is not sample-aligned.** Found in review. The first version rounded the west
  and north edges and took a *width*, so a west bound of 6.1 at 0.25° spacing selected the sample
  at 6.0 — outside the requested cut — and the east bound was never consulted at all. Every index
  now comes from its own endpoint by ceiling, with a 1e-6-sample tolerance so an exactly aligned
  bound cannot step to the next sample. The declared region is aligned, which is exactly why the
  defect was invisible: **the fixture's own bounds could not have exposed it**, and the real crop
  is byte-identical before and after the fix.
- **An internal tile that inflates to the wrong length.** Also found in review. An over-long tile
  is the dangerous direction: the predictor decodes it happily and the surplus samples are simply
  never indexed, so a source that changed its tiling would yield a plausible surface instead of a
  failure. The decompressed length is now asserted against the declared tiling before decoding.

*Author verification, and what the mutations found.* **34 mutations, all killed** — 29 against
the reader, 5 against `parseTileId`. Four of those kills only exist because a test was fixed
first, and all four are the same mistake: a check whose passing result would have looked
identical if the property were broken.

- The check that the reader fetches only the internal tiles a crop overlaps first placed the crop
  at the raster's north-west corner, where "start from the overlapping tile" and "start from tile
  zero" issue identical requests; then in a 2 × 2 internal grid, where every tile touches both a
  first and a last edge. Only a crop strictly inside a 3 × 3 grid observes all four bounds.
- The round-trip over the tile-id grid was named "every cell" while stepping by 7 and 13 — a
  sample calling itself a sweep. Measured rather than argued: the step-7 loop visited **26 of 180
  latitude bands**, neither 7 nor −7, so a parser wrong in exactly one band survived it. The
  exhaustive loop kills that mutation and costs 29 ms, because mismatches are collected rather
  than asserted per cell.

The instructive part is that in both cases the *name* of the check was accurate about intent and
wrong about reach, and reading it would not have shown that. Only breaking the subject did.

## The async wiring

**[verified 2026-08-30]** Two of the build's seams really fetch, so `runBuild`, `assertCoverage`
and `assertMinimumElevation` are async and `scripts/fixture/deps.mjs` binds the real probe and
reader behind them. The writer, the contour source and archive production are deliberately not
part of this.

`assertMinimumElevation` takes an **async** iterable rather than having the build resolve every
read first. That is what preserves the property the signature was chosen for: a tile is fetched
only when the floor check asks for the next one, so a cut over many source tiles holds one crop
at a time rather than all of them.

*Two traps, both of which produce a working-looking build.*

- **The probe must not reuse the range reader.** A reader that throws on a non-2xx turns a 404
  into a thrown probe, and `assertCoverage` classifies a thrown probe as `unreachable` — so an
  unpublished tile would arrive as a transport failure, telling a reader to retry a tile that
  will never exist and quietly retiring the distinction the coverage snapshot exists to draw.
  They are two functions on purpose. Confirmed against the bucket: `N45E006` → 206, `S90W180` →
  206, `N00E000` → **404 as a status**, not a throw.
- **Each tile is read for its own share.** A cut spanning two cells cannot hand its full bounds
  to either — the second tile's crop would begin west of its own raster. `clipBoundsToTile` gives
  each tile its part, and the parts meet *exactly* because `cropWindow` is half-open at its east
  and south edges: the column on a shared meridian belongs to the tile east of it and to that
  tile only. That is a property of the **pair**, so it is tested on the pair; neither clip alone
  can show it.

*The real-network boundary, hardened after review.* A status alone proves nothing about which
bytes arrived, and each of these decodes into plausible terrain rather than into an error, so
`rangeFetcher` now checks all of them: **200 is refused** (a server that ignores `Range` returns
the whole 42 MB object, whose opening bytes parse perfectly as the header they are not);
**`Content-Range`'s first byte must be the byte requested** (a correctly sized window from the
wrong offset inflates, because another internal tile is also a valid deflate stream, and yields
real terrain in the wrong place); and **the body's length must match what `Content-Range`
claims**. A range answered short *at the end of the object* is legitimate — HTTP returns the
intersection, so a 64 KB header window over a smaller object comes back smaller — and is accepted
only when the response says the object ended there; truncation mid-object is refused. The probe
also releases its one-byte body rather than walking away from it, since an unconsumed body keeps
its connection checked out, and the build makes one probe per required tile, serially.

*And a cleanup failure no longer eats the build failure.* `discardArchive` is `fs.rm` on a path a
failing build just wrote, so it can reject — and it rejects *after* the real failure, so a raw
rethrow replaced "the archive carries no LICENSE" with "permission denied" and dropped the stage
with it. Both are kept now: the stage stands and the cause becomes an `AggregateError`, original
first.

**The bug CI caught, and the regression test that first failed to catch it.** `undoFloatPredictor`
ended with `new Float32Array(bytes.slice().buffer)` under a comment claiming it copied. It does
not: `inflateSync` returns a **Buffer**, and `Buffer.prototype.slice` is the one method on Buffer
that disagrees with its `Uint8Array` namesake — it returns a *view*. `.buffer` was therefore the
whole allocation pool, and the floats were read from the pool's origin rather than from the tile.
Whether that was wrong depended entirely on where the allocator put the buffer: correct at offset
zero, which is what a large unpooled allocation gives, and silently another tile's bytes
otherwise. **The real 4 MB tiles were fine and the 64-byte synthetic ones were not**, on CI's
Node and not on this machine — so the local suite was green, the real-data run was green, and the
code was wrong. Fixed by copying into an `ArrayBuffer` the function owns.

The regression test is the part worth remembering. Written first with a `Uint8Array` view at a
deliberately unaligned offset, it looked exactly like a test for this and **passed against the
broken code**, because `Uint8Array.prototype.slice` copies. Only a `Buffer` view reproduces it.
Third instance in this task of the same shape: a check that names the property, looks thorough,
and cannot observe the defect. The mutation is what said so.

*Author verification.* 26 mutations killed across this increment — 15 for the wiring, in the
three classes the review named (dropped `await`, wrong tile, first-tile-only), and 11 for the
hardening above, including reverting the decode to the exact CI failure. One survived first: the
`await` on
`discardArchive` is invisible against a synchronous fake. Rather than keep a guard nobody can
check, the fake now defers over a **timer**, since microtasks drain completely before any timer
fires — so an unawaited discard is deterministically still pending when the rejection surfaces.
It matters once `discardArchive` is `fs.rm`, where a rejection nobody awaits is fatal in current
Node. The build suite's fakes are async by default for the same reason: against synchronous
fakes, every `await` in the build could be deleted without a single test noticing.

*What a scratchpad run showed, and what it does not establish.* Driven against real inputs — the
checked-in licence, attribution, region and coverage snapshot, a real S3 probe, a real COG read —
the assembled build reaches the archive stage and reports `mont-blanc-summit`, one tile
`N45E006`, lowest sample **2,560.80 m** at index 49,247. Re-run after the hardening above, the
live bucket satisfies every new check and the crop is unchanged. **No row moves to
*discharged*, for three separate reasons, and any one of them is sufficient:** the archive stage
was a **fake writer** and nothing was written; the run lives in a scratchpad, so no committed
path reproduces it; and only coverage's **present** branch was exercised, because every tile the
declared region needs is published — obligation 3's gap path cannot be reached by this region at
all. The run is evidence that the wiring is right, which is a different claim from an obligation
being met.

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

## The writer's acceptance properties — set before implementation

Recorded here **before any writer code exists**, for the reason the contour bars were: a bar
chosen after seeing what a candidate produces is a description, not a test. These come from
review on 2026-08-31 and they are the conditions for calling `s2-pmtiles` adopted.

1. **Independent readability.** A fixture archive with real raster payloads must open and read
   through an *independent* reader path — `pmtiles` 4.5.0, the version that actually ships — not
   through the writer's own APIs. Two implementations agreeing on a spec version is the claim;
   a writer validating its own output is not evidence for it.
2. **Range-read proof.** The archive must be read through the hardened `rangeFetcher`, covering
   the header, a directory lookup, and at least one tile payload. This is the property that joins
   the writer to the reader contract instead of proving two halves separately — and it is a
   relational property, so it is tested on the pair.
3. **Payload identity.** For known fixture tiles, the bytes recovered from the archive must be
   **byte-identical** to the payloads handed to the writer. Correct metadata and a correct index
   say nothing about whether compression or offset construction damaged the payload, which is the
   failure that would reach a renderer as corrupt terrain rather than as an error.

And four negatives, each of which must bite independently: a tile requested at the **wrong
offset**; a **truncated archive**; a **missing tile** (which must read back as absent, not as
empty data — obligation 3 rests on it); and a **writer finalisation failure**.

The existing leaf-directory evidence stands but does not discharge any of these: it was measured
on fifteen-byte string payloads, and payload identity at fifteen bytes is not payload identity at
tens of kilobytes.

### The confirmatory run — all three pass, and one finding that decides the sink

**[author-verified 2026-08-31, scratchpad only]** `s2-pmtiles` 1.1.2 is adopted (MIT, pinned
exactly, **no transitive dependencies** — which supersedes this plan's earlier note of one, on
`fflate`). Confirmed at fixture scale with real raster payloads: the real N45E006 crop, cut into
256 px terrarium **PNG** tiles of 15,208 and 121,118 bytes, padded to 4,000 tiles so leaf
directories are genuinely in play, giving a 61 MB archive.

| property | result |
| --- | --- |
| 1 — independent readability | `pmtiles` 4.5.0 reads it: spec version 3, tile type PNG, zooms 14–15, `leafDirectoryLength` 27,048 |
| 2 — range-read proof | read entirely through the hardened `rangeFetcher`: 18 range requests covering header, directory and payload |
| 3 — payload identity | 16 tiles — the first twelve and the last four, the latter resolving through a leaf — **byte-identical by sha256**, 0 mismatches |

A tile never written still reads back as `undefined` rather than as empty data, now confirmed at
fixture scale *with leaf directories present* rather than only in a four-tile archive. That is the
reader behaviour obligation 3's second leg rests on.

**The finding: `BufferWriter` is unusable at this scale, and the build must use `FileWriter`.**
`BufferWriter.append` is `for (let i = 0; i < data.byteLength; i++) await this.#buf.push(data[i])`
— one JS-array push *and one await* per byte. At fixture scale it threw `RangeError: Invalid
array length` before writing anything. `FileWriter.append` is a single `write` syscall per
payload and completed the same archive in 2.3 s. This is recorded because a first adoption
naturally reaches for the in-memory sink, especially in tests, and it fails in a way that reads
as a defect in the *archive* rather than in the sink.

Worth stating plainly, since the run initially looked like a verdict on the candidate: the first
failure was **the harness choosing the wrong sink**, not the writer being unfit. Suspecting the
instrument first is what turned a rejection into a configuration detail.

*What this does not establish.* The payloads are real DEM-derived PNG rasters, but their **tile
addressing is not**: they are laid out on a simple grid, not on the web-mercator pyramid a
renderer needs. Resampling the geographic crop into mercator tiles is the next increment, and
nothing above depends on it — property 3 is about the writer returning the bytes it was given.

### The writer, as built

`scripts/fixture/archive.mjs` exposes one function and no dependency concepts:

```
writeArchive(path, tiles, metadata, options?)   // tiles: { z, x, y, bytes }
```

`FileWriter`, tile-id conversion, header and directory construction and `commit` stay behind it,
and the payload type and compression are named in MAP-ATLAS terms (`"png" | "mvt"`,
`"none" | "gzip"`) rather than as the dependency's enums. **It owns no raster semantics**:
terrarium encoding, resampling and source-cell addressing are upstream, so the Web-Mercator
increment supplies a different pyramid without this file changing.

**Two ordering decisions, made here rather than inherited.** Both were left to whatever the
dependency did with the order it was handed, which is the kind of semantics that becomes load
bearing without anyone choosing it.

- *Tiles are sorted by archive tile id.* The output is then a function of the tile set rather
  than of the caller's iteration order — a depth-first pyramid walk and a breadth-first one
  produce identical bytes — and writing in id order is what lets the archive declare itself
  `clustered`, which is asserted through the independent reader rather than inferred from the
  sort.
- *A repeated address is refused*, identical bytes included. Two payloads at one address have no
  correct resolution; the dependency keeps the last, which is a silent answer to an ambiguous
  question. A caller that enumerates an address twice has a bug whether or not it is harmless
  this time.

A zero-byte payload is refused too: a tile never written reads back as `undefined`, and writing
an empty one would put something at the address that is neither data nor absence — the
distinction obligation 3 rests on.

**One architectural consequence, worth stating before it surprises someone.** PMTiles carries a
*single* compression setting per archive. Already-compressed PNG rasters want `none` and vector
tiles want `gzip`, so the terrain source and the contour source **cannot share an archive**
without one of them being wrong. They are separate sources to a renderer in any case, so the
fixture writes separate archives.

*The negatives, classified by which contract they belong to* — the distinction matters, because
turning the dependency's internals into MAP-ATLAS architecture would be a worse outcome than the
bugs it guards against:

| negative | contract | how it is tested |
| --- | --- | --- |
| finalisation failure | writer | injected at the sink, where `commit` writes the header back over the file's start; `writeArchive` rejects |
| duplicate / out-of-order input | writer | decided above, and asserted on both halves |
| missing tile | independent readback | the archive succeeds and `pmtiles` 4.5.0 returns `undefined` |
| wrong offset, truncation, header damage | corruption acceptance | the finished bytes are damaged and the independent reader through the hardened range path is shown to fail deterministically — no injectable wrong-offset seam inside the writer |

*Author verification.* 20 tests; 11 mutations killed on the writer, **three of them
test-of-tests**: each corruption case was re-run with its corruption removed, and each then
failed. "Assert the digest is *not* the expected one" is exactly the shape that passes when
nothing was corrupted at all.

## The Web-Mercator bars — set before implementation

Recorded before any resampling code exists, because this increment has enough degrees of freedom
that a plausible-looking terrain image would otherwise choose the semantics. From review on
2026-08-31; the arithmetic below was **recomputed here** rather than transcribed.

### 1. Addressing: XYZ, pixel centres, half-open at the region edge

Standard slippy-map Web Mercator. For output tile `(z, x, y)`, pixel `(col, row)` is the global
pixel **centre** `(x·256 + col + 0.5, y·256 + row + 0.5)`, inverse-projected to lon/lat and
sampled from the geographic DEM. The half-open rule already used by `requiredTiles` and
`cropWindow` continues to apply at the region boundary — west and north included, east and south
excluded — so a bound landing exactly on a tile edge does not acquire the neighbour.

`minZoom` and `maxZoom` are **explicit inputs**, not a product policy baked into the fixture.
**z11–12** for this region, and the tile ranges are computed, not assumed:

| zoom | x | y | tiles | m/px at 45.84°N | envelope |
| --- | --- | --- | --- | --- | --- |
| 11 | 1062..1063 | 729..730 | 4 | 53.25 | lon 6.67969..**7.03125**, lat 45.70618..45.95115 |
| 12 | 2125..2126 | 1459..1460 | 4 | 26.63 | lon 6.76758..6.94336, lat 45.76752..45.89001 |

One arcsecond at that latitude is 30.92 m of latitude and 21.54 m of longitude, so z12 sits
inside the source's native scale and z13 (13.31 m/px) would be roughly 2× upsampling.

**The floor is z11 for a harder reason than scale.** z10's envelope is lat 45.58329..46.07323 —
it crosses **46°N**, so it would require `N46E006` and `N46E007` as well. The zoom range chooses
which source cells the build must have, which makes it a coverage decision and not only a
resolution one.

The raster-dem source declares `maxzoom: 12`; a renderer uses maxzoom tiles when displayed
beyond it, so nothing is missing above z12.

### 2. Resampling: bilinear, in decoded metres

The contract, and the ordering in it is the whole point:

```
source encoded bytes -> decode to metres -> bilinear interpolate -> encode as terrarium
```

**Terrarium RGB channels are never interpolated.** The encoding packs a value across three
channels with carries between them, so averaging channels produces a number that is not the
average of the elevations — and is a perfectly well-formed colour, which is why it would render
as terrain rather than fail.

Bilinear rather than nearest: elevation is a continuous field and this is a reprojection onto a
different lattice, where nearest makes the result depend on grid alignment and staircases the
terrain.

*The oracle: an affine elevation plane* `h(lon, lat) = A·lon + B·lat + C`. Bilinear reproduces an
affine function **exactly** before quantisation, so one fixture kills nearest-neighbour, wrong
fractional coordinates, row/column swaps and channel interpolation at once. The output is then
asserted to differ from the analytical elevation by at most the terrarium step (1/256 m).

**A circularity this must avoid.** The affine oracle cannot catch a wrong *projection* if the
expected elevation is evaluated at a lon/lat obtained from the same projection code — both sides
move together and the check passes. So bar 2 tests interpolation and bar 4 tests projection, as
**separate assertions** over independently computed expected coordinates. Neither alone is
sufficient, and a single combined assertion would look stronger than the pair while proving less.

### 3. Edges: expand the read envelope; never invent no-data

The governing decision. A Mercator tile intersecting the region must still be a complete 256×256
raster, and none of these is acceptable: filling outside-region pixels with an arbitrary
elevation, clamping them to the region edge, omitting partially intersecting tiles, or inventing
a no-data RGB. There is no terrarium encoding for absence, which is the same reason obligation 3
has no fill path.

Two extents, kept distinct:

- **declared region** — what the consumer asked for, and what the archive's `bounds` metadata
  carries, so a renderer does not request tiles outside it.
- **production envelope** — the full footprints of every Mercator tile intersecting the region,
  plus the source-sample halo bilinear needs (one sample beyond each edge).

Real DEM samples are read for the whole production envelope. **If any required source sample is
unavailable, the build fails** rather than fabricating terrain.

*This changes coverage.* The build currently checks `requiredTiles(declaration.bounds)`, which
yields `N45E006` alone. The z11 envelope reaches 7.03125°E, so the envelope requires **`N45E007`
as well** — a real seam the fixture crosses rather than a constructed one. Coverage must be
computed over the production envelope, not the declared region, and that is a change to the
build's ordering, not only to the resampler.

### 4. Falsification: prove coordinates, not appearance

Pin two adjacent Mercator tiles and assert their border pixel centres land at the analytically
expected lon/lat — exactly one pixel apart, neither duplicated nor skipped — then run the affine
oracle across that boundary. Source-cell lookup crossing an integer degree keeps the existing
`PixelIsPoint` ownership rule, so the sample on a shared meridian belongs to one cell only.

**Mutations that must each bite independently:** dropping the `+0.5` centre offset; linear
latitude instead of inverse Mercator; nearest instead of bilinear; interpolating encoded RGB;
clamping outside the declared bbox; omitting the bilinear halo; and including an east or south
tile whose edge lies exactly on the bound.

### Addressing and the envelope, as built

`scripts/fixture/mercator.mjs` answers where a pixel is and what extent a pyramid needs. It
resamples nothing and knows no elevation.

*The projection is tested against an independently written oracle.* The module inverts with
`atan(sinh(...))`; the suite uses the Gudermannian's `2·atan(exp(y)) − π/2` form and a forward
`ln(tan(π/4 + φ/2))`. Mathematically equal, textually unrelated — so a transcription slip in one
does not reproduce itself in the other. Two published anchors sit under both, the equator landing
exactly halfway down the pyramid and the 85.0511287798066° limit at the top, because two formulas
that agree with each other can still both be wrong.

*Two test bugs found by running them, both mine.* The check that latitude is not linear asserted
the inequality **backwards**: Mercator stretches high latitudes, so a polar tile spans *fewer*
degrees than an equatorial one, not more. And a guard refusing bounds that "cover no tile" was
unreachable — with `west < east` guaranteed, a half-open upper edge steps back at most to the
tile the lower edge already occupies. It is removed and `tileRange` now uses the shared
`parseBounds`, so four call sites cannot drift on what a box is.

*Author verification.* 20 tests, 11 mutations killed, covering the list the bars named: the
`+0.5` centre offset dropped on both axes and on one; linear latitude for inverse Mercator; the
half-open upper edge; north and south swapped; the halo omitted per edge; and the envelope's east
and south taken from the wrong tile.

**Still to do before this discharges anything:** coverage is computed over `declaration.bounds`
and must move to the production envelope, which is a change to the build's ordering. Until it
does, a build for this region would check `N45E006` and then read `N45E007` unchecked.

### The resampler, as built

`scripts/fixture/resample.mjs` implements the ordering the bars fixed, and is arranged so the
forbidden step is *unavailable* rather than merely discouraged: `decodeGrid` is the only door in,
and everything past it holds `Float32Array` metres with no bytes in sight. Interpolating terrarium
channels is not a rule to remember here; there is nothing to interpolate.

`Float32Array` is deliberate: its ulp near 3,000 m is about 0.00024 m, some sixteen times finer
than the 1/256 m the encoding it round-trips through can represent, so storage is not the limiting
factor for anything that matters.

*The three oracles stay separate*, as the bars require, because each fails on its own account:

| oracle | what it can catch alone |
| --- | --- |
| projection (`mercator.test.mjs`) | a wrong formula, against an independently written restatement |
| interpolation (`resample.test.mjs`) | positions chosen directly in lon/lat, so **no projection is involved at all** |
| integration | both together — and never the only proof, since either could otherwise hide in the other |

The affine plane is `400·lon − 300·lat + 14000`. Its coefficients differ in magnitude on purpose:
with equal ones a transposed stencil would be invisible. The tolerance is 0.002 m, two orders of
magnitude below the ~0.055 m a nearest-neighbour implementation is off by on this plane, so the
oracle stays discriminating rather than merely satisfiable.

*Author verification.* 15 tests, 11 mutations killed — including the two the bars name by name,
nearest-neighbour and interpolating encoded RGB, plus clamping into the grid on either axis,
transposed weights, a wrong stencil corner, an inverted latitude axis, and a `decodeGrid` that
does not decode.

**Two mutations first reported as survivors, and both were the harness.** The patterns did not
match — prettier had reflowed one target onto a single line, and the other was indented
differently than the pattern assumed — so nothing was mutated and the suite passed for the most
boring possible reason. The runner now **compares the file before and after** and reports
`NOT APPLIED` rather than a verdict. The asymmetry is worth stating: a `killed` result is
self-verifying, because an unapplied mutation cannot fail the suite, so only `SURVIVED` was ever
ambiguous — but that is exactly the direction in which a false result is reassuring.

### The source surface, and a corrected premise about the seam

An output pixel near 7°E has a stencil straddling two source cells, so the cells are joined into
one grid *before* anything samples it and `resample.mjs` never learns that source cells exist.
Anything that picked a cell first and interpolated inside it would have to clamp or fail at the
boundary, which is what the edge rule forbids.

**The review's premise about duplicated seam samples does not hold for this source, and checking
was cheaper than designing around it.** GLO-30 ships 3600×3600 samples per 1° cell, so
`N45E006`'s easternmost sample is at **6.99972222°** and `N45E007`'s westernmost at **7.0°** —
exactly one spacing apart, continuing the same global lattice. Measured from both headers, not
assumed. There is therefore no duplicated boundary sample to arbitrate between and no ownership
rule needed at the join; `cropWindow`'s half-open edges already gave each sample to exactly one
crop.

What that leaves is the harder half. The two lattices must **interleave**, and a misalignment
produces a surface that is continuous, plausible and wrong. So alignment is asserted on the
global lattice — every crop's origin an integer number of samples from every other's — and every
cell of the result must be written **exactly once**, which detects a gap and a double-write in the
same pass.

*A limit worth stating rather than leaving implied.* This detects a crop *placed* wrongly. It
cannot detect a crop whose declared origin disagrees with its own pixels, because that still tiles
perfectly. That case is caught upstream instead, by the reader's tiepoint cross-check against the
cell the tile id names — the two guards are complementary, and neither covers the other.

*Author verification.* 15 tests, 11 mutations killed. **Three survived first, all the same
blind spot**, and it is the one this task keeps returning to: the fixture had no variation on the
axis under test. Every crop shared one `north`, so flipping the north axis' sign changed nothing;
and the first crop was always the north-westernmost, so an origin that ignored the union's offset
was indistinguishable from one that did not — on longitude first, then again on latitude after
only half the fix. A north–south pair and a reversed input order on **both** axes make all three
observable. The vacuous-fixture failure also appeared in the tests themselves: a poison window of
"outside columns 0..7" on an eight-column crop poisons nothing, and that test passed without a
single poisoned sample existing.

### PNG, as its own increment

`scripts/fixture/png.mjs` takes width, height and RGB bytes and returns a PNG. It knows nothing
about elevation, terrarium or Mercator, which is what lets a binary format be proven with no
network, projection, archive or coverage anywhere near it.

Deliberately plain: 8-bit truecolour (`colorType` 2, no alpha), non-interlaced, one `IDAT`,
scanline filter **0** everywhere. Filtering exists to help compression, compression efficiency is
not a fixture requirement, and a per-row filter heuristic would add a decision whose only
observable effect is archive size — a bug in it would show up as slightly larger files and
nothing else. Terrarium pixels are poor candidates anyway: the low byte changes constantly, so
the usual predictors buy little. **Measured: 2.68 bytes per pixel against 3 raw**, on a 256 px
tile of plausible alpine elevations, which is the number archive sizing should be based on rather
than a hoped-for compression ratio.

*The oracle is byte identity after decoding, not that a parser tolerated the file.* The suite
parses from the bytes up — chunk walk, every CRC checked, `IDAT`s concatenated, inflated, filter
byte stripped per row — and asserts the recovered RGB equals the input exactly. The CRC is
checked against a **table-free bitwise** formulation of the same polynomial, anchored by the
published `0xAE426082` for an empty `IEND`, so a mistake in building the encoder's table cannot
reproduce itself in the check.

The fixture pattern varies red with column, green with row and blue with both, and **the suite
asserts its own discriminating power** — that all three channels differ at every pixel — because
if the pattern ever became channel-symmetric, every swap mutation would quietly stop biting.
Sizes are non-square in both directions so a width/height transpose is structural.

*Author verification.* 10 tests, **14 mutations killed**: wrong height, transposed dimensions,
alpha declared, wrong bit depth, interlacing declared, filter bytes dropped, a row written over
its own filter byte, a source stride including the filter byte, R and B swapped, a CRC covering
the length field, a zeroed CRC, an omitted `IDAT`, an undeflated `IDAT`, and the byte-count check
removed. Separately and outside the suite, macOS ImageIO reads the output as 256×256, 8 bits per
sample, 3 samples per pixel — an independent decoder, where the suite's parser is still ours.
Whether MapLibre accepts these bytes as `raster-dem` is the browser lane's to establish.

### Orchestration, and two things only a real run could find

The wiring adds no algorithm; it composes proven pieces in the order the bars fixed. Coverage now
runs over the **production envelope**, so no source cell can be read that coverage did not first
admit — the mandatory mutation reverting it to `requiredTiles(declaration.bounds)` is killed,
and a companion test shows the second cell is genuinely *required* by failing at the coverage
stage when it is withheld.

**Both findings came from running the whole chain, not from the suite**, and both were invisible
to unit tests for the same reason: the harness computed the envelope itself instead of being
handed one, so it agreed with the code rather than checking it.

1. *The reader was clipping to the declaration while coverage admitted over the envelope.* For
   `N45E007` the two do not intersect, and the clip produced a degenerate box. `readTile` now
   takes the bounds per call — the build owns the extent, so the build passes it — and a test
   asserts the value that actually crosses the seam.
2. *The floor was being judged over the envelope.* The first real run failed at **554 m**: a
   valley within a z11 tile's width of the summit. Judging the envelope turns "this region is
   above the treeline" into "everything within a tile of it is", which no mountain satisfies.
   ADR-0024 makes the declared region the subject and the archive advertises those same bounds,
   so the floor is now judged over the region while the envelope is only *read*. A cell that
   contributes no in-region sample is skipped, which for this fixture is exactly `N45E007`.

*Author verification.* 41 build tests; 14 mutations killed, including coverage reverted to the
declaration, the archive advertising the envelope, a pyramid built from one zoom, a surface from
one cell, the halo dropped, the spacing assumption unchecked, the read bounds reverted, and four
on the region window. One survived and was **removed rather than kept**: a guard for "no cell
contributed a sample" is unreachable, since the envelope contains the region by construction, and
`assertMinimumElevation`'s own tested empty-cut guard covers the impossible case anyway.

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
