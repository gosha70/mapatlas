# T4.6 — vertical acceptance fixture: implementation plan

Derived from `specs/tasks.md` (T4.6) and ADR-0024. Where this plan and those disagree, they
win and this is stale. Claims below are marked **[verified]** when checked in-repo or against a
dependency's source this session, and **[to verify]** when they are expectations that must be
confirmed before they are built on. Nothing here is marked verified on the strength of
recollection.

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

**[blocked 2026-08-30]** The strings themselves are inputs and are deliberately absent. ADR-0024
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
**[to verify]** whether a pure-npm path from GeoJSON to MVT exists at acceptable quality.

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

1. **The GeoJSON→MVT half of the contour toolchain** — the only open item that could still
   change the toolchain rather than fill it in. Two bars, set before looking, and specific to
   contour geometry rather than to vector tiles in general:

   - **Seam continuity.** Coordinate quantization at tile boundaries leaves contour lines that
     do not meet across the seam. A single tile renders perfectly; the defect exists only
     between adjacent tiles.
   - **Small-loop survival.** Simplification at low zoom closes or drops small closed contours —
     a knoll or a hollow vanishing, or worse, becoming a line. Again invisible in isolation.
     The instrument is a ring count per zoom, but a count alone says rings were dropped, not
     whether the right ones were: rings present at z14 and absent at z10 is correct behaviour.
     So the comparison basis is named now rather than read off the first candidate's curve —
     **a closed ring must survive at every zoom where its own extent is still perceptible**,
     which pins the bar to what a reader could see rather than to what a tool happens to do.
     The pixel figure is set with the fixture's line width and target display, before output
     exists.

   Both share the leaf-directory shape, and the shape has a tell worth naming: **when a
   property's statement contains a relational word — meets, matches, survives across, agrees
   with, continues into — the unit under test is the pair, not the thing.** No amount of testing
   individual artifacts reaches a property that lives between them. Three instances in this task
   alone: leaf directories versus a root-only archive, seam continuity between adjacent tiles,
   and the pointer and DOM lanes agreeing on which vertex is under a tap. Each was invisible to
   a test that looked complete.

   So the check must be built to cross the boundary deliberately — render adjacent tiles together and compare
   endpoints across the seam, and count closed rings per zoom level rather than eyeballing one
   tile. Deciding this before a candidate's output is on screen is what stops the output from
   setting the bar.
2. **Archive size** — answerable once (1) is settled; the region is now declared and verified.
   ADR-0024 criterion 6 requires the result **measured** rather than calculated.

**Status of the writer, stated precisely so a summary cannot round it up.** `s2-pmtiles` is a
well-evidenced candidate, not yet a committed dependency. Verified: the API shape, a four-tile
round-trip, and leaf directories past their threshold in both compression modes with the header
fields asserted. Not verified: the same at fixture scale with real raster terrarium payloads of
tens of kilobytes rather than fifteen-byte strings — which moves tile counts and archive size,
though it should not move directory structure. That remaining run is **confirmatory rather than
exploratory**, and the distinction is worth keeping in both directions: calling it outstanding
overstates the risk, calling the question answered understates it.
