# T4.6 — vertical acceptance fixture: implementation plan

Derived from `specs/tasks.md` (T4.6) and ADR-0024. Where this plan and those disagree, they
win and this is stale. Claims below are marked **[verified]** when checked in-repo or against a
dependency's source this session, and **[to verify]** when they are expectations that must be
confirmed before they are built on. Nothing here is marked verified on the strength of
recollection.

## What ships

1. `scripts/build-fixture-archive.mjs` — cuts a PMTiles archive from Copernicus DEM GLO-30
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
| 1 | Licence strings carried verbatim | Attribution and liability strings compared byte-for-byte against the checked-in licence document, then written into the archive and a `LICENSE` inside it | which string drifted, and both values |
| 2 | Released coverage, per tile | Every tile in the cut is read; a read that finds nothing is a gap | the tile: `no published tile at N45E007` |
| 3 | A gap fails rather than fills | No fill path exists in the encoder — the absence of a branch, not a guarded one | as (2) |
| 4 | Region is above the treeline | The cut's lowest decoded sample is compared against the region's declared `minElevationM` | the sample, its tile, and the declared floor |

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
- What a list adds is **classification**, and classification is not optional. Withheld-by-policy
  and something-broke produce the *same* absent read. A build that cannot tell them apart has
  only two behaviours available, and both are wrong: fail on a legitimate gap that means "choose
  another region", or pass over a real fetch failure that means "retry". The snapshot is what
  makes the two distinguishable — so detection being free does not make the list optional, it
  moves what the list is for.
- So the snapshot records a **decision input** (was this region viable when it was chosen?)
  rather than caching a dependency the build's correctness rests on. A stale snapshot yields a
  less helpful failure, never a wrong archive.
- It therefore carries a retrieval date **and** a maximum age that fails the build on its own,
  because a date alone asks the reader to judge staleness with no basis. The age is generous —
  GLO-30 Public's withheld set is a published policy, not a live service's availability — and
  being generous costs nothing precisely because the snapshot is not load-bearing.

## Region selection is a process, not a value in this plan

A candidate is proposed with: bounds, a declared `minElevationM` with its justification, and its
per-tile coverage checked against the snapshot. It is named in the fixture declaration only once
those hold. Constraints from ADR-0024: above the treeline, inland, released coverage, and enough
relief that terrain, hillshade and contours are worth demonstrating.

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
   change the toolchain rather than fill it in.
2. **The region** — independent of (1), pending its per-tile coverage check and a justified
   `minElevationM`.
3. **Archive size** — answerable only once (1) and (2) are settled, and ADR-0024 criterion 6
   requires it **measured** rather than calculated.

**Status of the writer, stated precisely so a summary cannot round it up.** `s2-pmtiles` is a
well-evidenced candidate, not yet a committed dependency. Verified: the API shape, a four-tile
round-trip, and leaf directories past their threshold in both compression modes with the header
fields asserted. Not verified: the same at fixture scale with real raster terrarium payloads of
tens of kilobytes rather than fifteen-byte strings — which moves tile counts and archive size,
though it should not move directory structure. That remaining run is **confirmatory rather than
exploratory**, and the distinction is worth keeping in both directions: calling it outstanding
overstates the risk, calling the question answered understates it.
